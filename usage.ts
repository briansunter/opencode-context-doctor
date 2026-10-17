/**
 * Provider-reported token usage accounting.
 *
 * Three distinct surfaces, never mixed:
 *
 * 1. `session.usage.updated` events carry CUMULATIVE session totals. A newer
 *    event REPLACES the previous value - values must never be summed. This
 *    data is ephemeral: it exists only while the plugin is loaded.
 * 2. Durable fallback: per-step assistant token records read from
 *    `ctx.session.context({ sessionID })`. Summing these per-step records
 *    reconstructs cumulative totals after a plugin or server restart.
 * 3. `session.usage.recorded` events (title/compaction auxiliary requests)
 *    are recorded as auxiliary detail and NEVER added to the primary totals.
 *    The event exists in the 2.0.32 binary but is missing from the 2.0.30
 *    typed event union, so it is matched defensively by type string.
 *
 * Every number that enters this module leaves it labeled with its source.
 */

export interface ReportedTokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface CumulativeUsage {
  readonly tokens: ReportedTokens
  readonly capturedAt: number
  readonly source: "session.usage.updated"
  readonly ephemeral: true
}

export interface AuxiliaryUsageRecord {
  readonly source: string
  readonly capturedAt: number
  readonly tokens: ReportedTokens
}

export interface SessionUsage {
  /** Latest cumulative total from `session.usage.updated` (replace, not sum). */
  live?: CumulativeUsage
  /** Bounded auxiliary records (title/compaction). Never summed into totals. */
  readonly auxiliary: AuxiliaryUsageRecord[]
}

export const maxAuxiliaryRecords = 20

/** Defensive coercion of an unknown `tokens` payload into ReportedTokens. */
export function parseTokens(value: unknown): ReportedTokens | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  const num = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0)
  if (typeof v.input !== "number" && typeof v.output !== "number") return undefined
  const cache = (typeof v.cache === "object" && v.cache !== null ? v.cache : {}) as Record<string, unknown>
  return {
    input: num(v.input),
    output: num(v.output),
    reasoning: num(v.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  }
}

export function emptySessionUsage(): SessionUsage {
  return { auxiliary: [] }
}

/** Replace-not-sum: a newer cumulative event overwrites the stored snapshot. */
export function applyCumulative(usage: SessionUsage, tokens: ReportedTokens, capturedAt: number): SessionUsage {
  const current = usage.live
  if (current && current.capturedAt > capturedAt) return usage
  return { ...usage, live: { tokens, capturedAt, source: "session.usage.updated", ephemeral: true } }
}

export function applyAuxiliary(usage: SessionUsage, source: string, tokens: ReportedTokens, capturedAt: number): SessionUsage {
  const auxiliary = [...usage.auxiliary, { source, capturedAt, tokens }]
  return { ...usage, auxiliary: auxiliary.slice(-maxAuxiliaryRecords) }
}

export interface UsageEventData {
  readonly kind: "cumulative" | "auxiliary" | "ignored"
  readonly sessionID?: string
  readonly source?: string
  readonly tokens?: ReportedTokens
}

/**
 * Classify a server event for usage tracking. `event.created` is the event
 * timestamp. Unknown or malformed events are ignored, never thrown.
 */
export function classifyUsageEvent(event: { type: string; created?: number; data?: unknown }): UsageEventData {
  const data = (typeof event.data === "object" && event.data !== null ? event.data : {}) as Record<string, unknown>
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  if (event.type === "session.usage.updated") {
    const tokens = parseTokens(data.tokens)
    if (!sessionID || !tokens) return { kind: "ignored" }
    return { kind: "cumulative", sessionID, tokens }
  }
  if (event.type === "session.usage.recorded") {
    const tokens = parseTokens(data.tokens)
    if (!sessionID || !tokens) return { kind: "ignored" }
    return { kind: "auxiliary", sessionID, source: typeof data.source === "string" ? data.source : "unknown", tokens }
  }
  return { kind: "ignored" }
}

// ---------------------------------------------------------------------------
// Durable per-step fallback
// ---------------------------------------------------------------------------

export interface PerStepUsage {
  readonly tokens: ReportedTokens
  readonly createdAt: number
  readonly model: string
}

export interface DurableUsageSummary {
  readonly steps: number
  readonly total: ReportedTokens
  readonly last?: PerStepUsage
}

function addTokens(a: ReportedTokens, b: ReportedTokens): ReportedTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

export const zeroTokens: ReportedTokens = Object.freeze({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

/**
 * Sum per-step assistant token records from `session.context` messages.
 * `messages` is read defensively; malformed entries are skipped.
 */
export function summarizeDurableUsage(
  messages: readonly unknown[],
  extract: (message: unknown) => { tokens?: unknown; createdAt?: number; model?: unknown } | undefined,
): DurableUsageSummary {
  let total: ReportedTokens = zeroTokens
  let steps = 0
  let last: PerStepUsage | undefined
  for (const message of messages) {
    const info = extract(message)
    if (!info) continue
    const tokens = parseTokens(info.tokens)
    if (!tokens) continue
    const createdAt = typeof info.createdAt === "number" ? info.createdAt : 0
    total = addTokens(total, tokens)
    steps += 1
    if (!last || createdAt >= last.createdAt) {
      last = {
        tokens,
        createdAt,
        model: typeof info.model === "string" ? info.model : "",
      }
    }
  }
  return last === undefined ? { steps, total } : { steps, total, last }
}

export const USAGE_NOTES: readonly string[] = [
  "session.usage.updated carries cumulative session totals: newer values replace older ones and are never summed. This data is ephemeral (kept only while the plugin is loaded).",
  "The durable fallback sums per-step assistant token records from session.context; it survives plugin and server restarts.",
  "session.usage.recorded events (title/compaction requests) are listed as auxiliary and never added to primary totals.",
  "The latest reported values may lag the newest snapshot: usage is recorded when a reply completes, snapshots when a request assembles.",
]
