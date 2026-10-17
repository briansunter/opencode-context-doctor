/**
 * Bounded, in-memory, per-session snapshot store.
 *
 * Snapshots are aggregate analyses only - no raw prompt, message, tool
 * description, or schema content is ever stored (see analytics.ts). All
 * bounds are enforced on write; there are no timers, so the store leaks
 * nothing when the plugin unloads.
 */
import type { Analysis } from "./analytics.ts"
import type { SessionUsage } from "./usage.ts"

export interface StoreOptions {
  /** Maximum number of sessions tracked per location (LRU-evicted). */
  readonly maxSessions?: number
  /** Maximum snapshots retained per session (oldest dropped). */
  readonly maxSnapshotsPerSession?: number
  /** Sessions idle longer than this are swept on the next write. */
  readonly sessionIdleMs?: number
  readonly now?: () => number
}

export const storeDefaults = Object.freeze({
  maxSessions: 50,
  maxSnapshotsPerSession: 20,
  sessionIdleMs: 24 * 60 * 60 * 1000,
})

export interface HookErrorRecord {
  count: number
  lastAt?: number
  /** Fixed error code from a closed vocabulary - never free-form messages (privacy). */
  lastCode?: string
}

export interface SessionRecord {
  readonly sessionID: string
  snapshots: readonly Analysis[]
  errors: { count: number; lastAt?: number; lastCode?: string }
  /** Ephemeral reported-usage state (never persisted, never summed; see usage.ts). */
  usage: SessionUsage
  lastActiveAt: number
  /** Monotonic touch counter: LRU tie-break when clocks do not advance. */
  touchSequence: number
  lastSignature?: string
}

export interface SessionSummary {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly snapshotCount: number
  readonly lastCapturedAt: number
  readonly lastEstimatedInputTokens: number
  readonly lastMessageCount: number
  readonly hookErrorCount: number
  readonly lastActiveAt: number
}

export interface RecordResult {
  readonly stored: boolean
  readonly reason?: "unchanged"
}

export interface StoreStats {
  /** Sessions with at least one stored snapshot. */
  readonly sessionsWithSnapshots: number
  /** Sessions tracked only because captures failed (0 snapshots, errors recorded). */
  readonly sessionsWithErrorOnly: number
}

export interface SnapshotStore {
  record(analysis: Analysis): RecordResult
  /** `code` must come from the fixed vocabulary in error-codes.ts; free-form messages are never stored. */
  recordError(sessionID: string, code: string): void
  get(sessionID: string): SessionRecord | undefined
  list(): readonly SessionSummary[]
  /** Bounded counts for diagnostics; no per-session detail. */
  stats(): StoreStats
  /**
   * Restore a persisted session (disk hydration). Live state always wins:
   * an entry captured since the store was created is never overwritten, so
   * the load-vs-live capture race resolves in favor of the newest data.
   * Returns true when the record was inserted.
   */
  hydrateRecord(record: { sessionID: string; snapshots: readonly unknown[]; errors: { count: number; lastAt?: number; lastCode?: string }; lastActiveAt: number }): boolean
  readonly maxSessions: number
  readonly maxSnapshotsPerSession: number
  dispose(): void
}

/** Deterministic stable stringify (sorted keys) used for change detection. */
export function stableStringify(value: unknown): string {
  const out = serialize(value, new WeakSet())
  return out === undefined ? "" : out
}

function serialize(value: unknown, seen: WeakSet<object>): string | undefined {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (seen.has(value)) return '"[circular]"'
  seen.add(value)
  if (Array.isArray(value)) {
    const items = value.map(item => serialize(item, seen) ?? "null")
    return `[${items.join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, seen) ?? "null"}`)
    .join(",")
  return `{${entries}}`
}

/** Change signature: everything except the timestamp, so identical re-observations dedupe. */
export function analysisSignature(analysis: Analysis): string {
  return stableStringify({ ...analysis, capturedAt: 0 })
}

export function createSnapshotStore(options: StoreOptions = {}): SnapshotStore {
  const maxSessions = clampInt(options.maxSessions, 1, 500, storeDefaults.maxSessions)
  const maxSnapshots = clampInt(options.maxSnapshotsPerSession, 1, 200, storeDefaults.maxSnapshotsPerSession)
  const idleMs = clampInt(options.sessionIdleMs, 1_000, 30 * 24 * 60 * 60 * 1000, storeDefaults.sessionIdleMs)
  const now = options.now ?? (() => Date.now())
  const sessions = new Map<string, SessionRecord>()
  let touchCounter = 0

  function entryFor(sessionID: string, at: number): SessionRecord {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    touchCounter += 1
    const record: SessionRecord = {
      sessionID,
      snapshots: [],
      errors: { count: 0 },
      usage: { auxiliary: [] },
      lastActiveAt: at,
      touchSequence: touchCounter,
    }
    sessions.set(sessionID, record)
    return record
  }

  function touch(entry: SessionRecord, at: number): void {
    touchCounter += 1
    entry.lastActiveAt = at
    entry.touchSequence = touchCounter
  }

  function sweepIdle(at: number): void {
    for (const [id, entry] of sessions) {
      if (at - entry.lastActiveAt > idleMs) sessions.delete(id)
    }
  }

  function enforceCapacity(): void {
    while (sessions.size > maxSessions) {
      let oldestID: string | undefined
      let oldestActive = Number.POSITIVE_INFINITY
      let oldestTouch = Number.POSITIVE_INFINITY
      for (const [id, entry] of sessions) {
        const older =
          entry.lastActiveAt < oldestActive || (entry.lastActiveAt === oldestActive && entry.touchSequence < oldestTouch)
        if (older) {
          oldestActive = entry.lastActiveAt
          oldestTouch = entry.touchSequence
          oldestID = id
        }
      }
      if (oldestID === undefined) break
      sessions.delete(oldestID)
    }
  }

  return {
    maxSessions,
    maxSnapshotsPerSession: maxSnapshots,
    record(analysis) {
      const at = now()
      const entry = entryFor(analysis.sessionID, at)
      touch(entry, at)
      const signature = analysisSignature(analysis)
      if (entry.snapshots.length > 0 && entry.lastSignature === signature) {
        return { stored: false, reason: "unchanged" }
      }
      // Push then bound: slice(-(max - 1)) is wrong for max === 1 (slice(-0) keeps everything).
      const next = [...entry.snapshots, analysis]
      entry.snapshots = next.length > maxSnapshots ? next.slice(next.length - maxSnapshots) : next
      entry.lastSignature = signature
      sweepIdle(at)
      enforceCapacity()
      return { stored: true }
    },
    recordError(sessionID, code) {
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      // First-capture failures must be visible: create the entry so the
      // error count survives even when no snapshot was ever stored.
      const entry = entryFor(sessionID, now())
      entry.errors = {
        count: entry.errors.count + 1,
        lastAt: now(),
        lastCode: code,
      }
    },
    get(sessionID) {
      return sessions.get(sessionID)
    },
    hydrateRecord(input) {
      if (typeof input.sessionID !== "string" || input.sessionID.length === 0) return false
      // Load-vs-live race safety: a live capture during hydration always wins.
      if (sessions.has(input.sessionID)) return false
      const valid = input.snapshots.filter(
        (snapshot): snapshot is Analysis =>
          typeof snapshot === "object" && snapshot !== null && typeof (snapshot as Analysis).sessionID === "string",
      )
      const snapshots = valid.length > maxSnapshots ? valid.slice(valid.length - maxSnapshots) : valid
      touchCounter += 1
      const record: SessionRecord = {
        sessionID: input.sessionID,
        snapshots,
        errors:
          typeof input.errors === "object" && input.errors !== null
            ? {
                count: typeof input.errors.count === "number" ? input.errors.count : 0,
                ...(typeof input.errors.lastAt === "number" ? { lastAt: input.errors.lastAt } : {}),
                ...(typeof input.errors.lastCode === "string" ? { lastCode: input.errors.lastCode } : {}),
              }
            : { count: 0 },
        // Live cumulative usage is ephemeral by design and is not restored;
        // the durable per-step fallback and the next usage event re-fill it.
        usage: { auxiliary: [] },
        lastActiveAt: typeof input.lastActiveAt === "number" ? input.lastActiveAt : now(),
        touchSequence: touchCounter,
        // Re-derived from the newest snapshot so unchanged re-observations
        // still dedupe after a restart, exactly like the capture path.
        ...(snapshots.length > 0 ? { lastSignature: analysisSignature(snapshots[snapshots.length - 1]!) } : {}),
      }
      sessions.set(input.sessionID, record)
      return true
    },
    list() {
      return [...sessions.values()]
        .filter(entry => entry.snapshots.length > 0)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.touchSequence - a.touchSequence || a.sessionID.localeCompare(b.sessionID))
        .map(entry => {
          const latest = entry.snapshots[entry.snapshots.length - 1]!
          return {
            sessionID: entry.sessionID,
            agent: latest.agent,
            model: latest.model,
            snapshotCount: entry.snapshots.length,
            lastCapturedAt: latest.capturedAt,
            lastEstimatedInputTokens: latest.totals.estimatedInputTokens,
            lastMessageCount: latest.messages.total,
            hookErrorCount: entry.errors.count,
            lastActiveAt: entry.lastActiveAt,
          }
        })
    },
    stats() {
      let sessionsWithSnapshots = 0
      let sessionsWithErrorOnly = 0
      for (const entry of sessions.values()) {
        if (entry.snapshots.length > 0) sessionsWithSnapshots += 1
        else sessionsWithErrorOnly += 1
      }
      return { sessionsWithSnapshots, sessionsWithErrorOnly }
    },
    dispose() {
      sessions.clear()
    },
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}
