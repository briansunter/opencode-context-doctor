/**
 * Main-thread persistence manager.
 *
 * Hard rule: the context-hook / model critical path never waits on disk,
 * compression, or SQLite. `markDirty` is O(1) map bookkeeping (bounded by
 * the store's session cap) plus an unref'd debounce timer; serialization,
 * gzip, and all SQLite statements happen in the worker thread
 * (persist-worker.ts). Flushes are serialized (one in-flight batch; further
 * captures coalesce into the next batch), so per-session ordering is
 * preserved and the worker queue is bounded by construction.
 *
 * Failure model: any storage failure degrades explicitly - a fixed
 * PERSIST_ERROR_CODES code lands in diagnostics, and the in-memory store
 * keeps working unchanged (memory stays the source of truth; the next
 * capture schedules a retry).
 */
import { Worker } from "node:worker_threads"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { PersistErrorCode } from "./error-codes.ts"
import type {
  PersistBudgets,
  PersistFlushResult,
  PersistFlushRow,
  PersistHealthResult,
  PersistHydrateResult,
  PersistInitResult,
  PersistLocation,
  PersistRequest,
  PersistResponse,
} from "./persist-protocol.ts"
import type { SnapshotStore } from "./store.ts"
import { GLOBAL_STATS_NOTES, type GlobalStatsPayload, type PersistenceHealth, type PersistenceStatus } from "./types.ts"

/** Canonical per-location key: directory plus optional workspace discriminator. */
export function locationKey(directory: string, workspaceID?: string): string {
  return workspaceID !== undefined && workspaceID.length > 0 ? `${directory}#${workspaceID}` : directory
}

/**
 * Default on-disk state directory for this plugin's OWN data (never inside
 * OpenCode's data directory, never its database): the XDG data home.
 */
export function defaultStorageDirectory(): string {
  const xdg = process.env.XDG_DATA_HOME
  const base = typeof xdg === "string" && xdg.length > 0 && xdg.startsWith("/") ? xdg : join(homedir(), ".local", "share")
  return join(base, "opencode-context-doctor")
}

export const persistDefaults = Object.freeze({
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  byteBudgetBytes: 32 * 1024 * 1024,
  debounceMs: 1_500,
  maintenanceIntervalMs: 60_000,
  disposeTimeoutMs: 2_500,
})

export interface PersistenceOptions {
  /** Canonical location directory (per-location isolation key part 1). */
  readonly directory: string
  readonly workspaceID?: string
  /** Overrides the default user state directory (tests, explicit opt-out paths). */
  readonly storageDirectory?: string
  readonly budgets: PersistBudgets
  readonly debounceMs?: number
  readonly maintenanceIntervalMs?: number
  readonly now?: () => number
  /** Injectable transport factory for deterministic tests; defaults to a real worker. Throwing = spawn failure. */
  readonly backend?: () => PersistenceBackend
  readonly workerPath?: string
}

export interface PersistenceBackend {
  post(message: PersistRequest): void
  onMessage(listener: (response: PersistResponse) => void): void
  terminate(): Promise<void>
}

export class RealWorkerBackend implements PersistenceBackend {
  private readonly worker: Worker
  constructor(workerPath: string) {
    this.worker = new Worker(workerPath)
  }
  post(message: PersistRequest): void {
    this.worker.postMessage(message)
  }
  onMessage(listener: (response: PersistResponse) => void): void {
    this.worker.on("message", listener as (value: unknown) => void)
  }
  async terminate(): Promise<void> {
    await this.worker.terminate()
  }
}

interface Pending {
  resolve: (value: never) => void
  reject: (error: PersistFailure) => void
  timer: ReturnType<typeof setTimeout>
}

/** Rejection carries a fixed code only - never error text (privacy). */
export interface PersistFailure {
  readonly code: PersistErrorCode
}

export interface Persistence {
  /** O(1), synchronous, safe to call from the context hook. */
  markDirty(sessionID: string): void
  /** Restores persisted sessions into the store (live captures always win). Resolves once. */
  hydrate(): Promise<void>
  /** Serial flush; resolves when the current batch (if any) is written or failed. */
  flushNow(): Promise<void>
  /** Bounded on-demand aggregate across all locations (worker-side query). */
  globalStats(topN: number): Promise<GlobalStatsPayload>
  /** Sync health snapshot (local counters + last known worker totals). */
  health(): PersistenceHealth
  /** Refreshes worker totals with a bounded query, then returns health. */
  refreshHealth(): Promise<PersistenceHealth>
  /** Flushes the durable queue (bounded wait), then terminates the worker. */
  dispose(timeoutMs?: number): Promise<void>
  readonly location: PersistLocation
}

const REQUEST_TIMEOUT_MS: Record<PersistRequest["kind"], number> = {
  init: 10_000,
  hydrate: 15_000,
  flush: 10_000,
  globalStats: 5_000,
  health: 2_000,
}

export function createPersistence(store: SnapshotStore, options: PersistenceOptions): Persistence {
  const now = options.now ?? (() => Date.now())
  const directory = options.storageDirectory ?? defaultStorageDirectory()
  const loc: PersistLocation = {
    key: locationKey(options.directory, options.workspaceID),
    directory: options.directory,
    ...(options.workspaceID !== undefined ? { workspaceID: options.workspaceID } : {}),
  }
  const debounceMs = options.debounceMs ?? persistDefaults.debounceMs
  const maintenanceIntervalMs = options.maintenanceIntervalMs ?? persistDefaults.maintenanceIntervalMs

  let status: PersistenceStatus = "pending"
  let lastErrorCode: string | undefined
  let lastErrorAt: number | undefined
  let disposed = false
  /** Set during dispose: blocks new work but allows the final forced flush. */
  let disposing = false
  let hydrated = false
  const dirty = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushInFlight: Promise<void> | undefined
  let lastMaintenanceTrigger = 0

  // Local counters (survive worker restarts/replies; feed diagnostics).
  let flushes = 0
  let flushFailures = 0
  let flushedSessions = 0
  let lastFlushAt: number | undefined
  let writtenRawBytes = 0
  let writtenCompressedBytes = 0
  let hydratedSessions = 0
  let hydratedAt: number | undefined
  let workerHealth: PersistHealthResult | undefined
  let initInfo: PersistInitResult | undefined

  let backend: PersistenceBackend | undefined
  let seq = 0
  const pending = new Map<number, Pending>()

  const recordError = (code: PersistErrorCode): void => {
    lastErrorCode = code
    lastErrorAt = now()
  }

/** Distributive Omit so request payloads keep their per-kind union shape. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
type PersistRequestPayload = DistributiveOmit<PersistRequest, "id">

  const request = <T>(payload: PersistRequestPayload): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      if (backend === undefined) {
        reject({ code: "disabled" } satisfies PersistFailure)
        return
      }
      seq += 1
      const id = seq
      const timer_ = setTimeout(() => {
        pending.delete(id)
        recordError("timeout")
        reject({ code: "timeout" } satisfies PersistFailure)
      }, REQUEST_TIMEOUT_MS[payload.kind])
      timer_.unref?.()
      pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        timer: timer_,
      })
      backend!.post({ ...payload, id } as PersistRequest)
    })
  }

  const handleResponse = (response: PersistResponse): void => {
    const waiter = pending.get(response.id)
    if (waiter === undefined) return
    pending.delete(response.id)
    clearTimeout(waiter.timer)
    if (response.ok) {
      ;(waiter.resolve as (value: unknown) => void)(response.result)
    } else {
      recordError(response.code)
      waiter.reject({ code: response.code } satisfies PersistFailure)
    }
  }

  const schedule = (): void => {
    if (disposed || disposing || status !== "active" || timer !== undefined || flushInFlight !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, debounceMs)
    timer.unref?.()
  }

  const collect = (): PersistFlushRow[] => {
    const rows: PersistFlushRow[] = []
    for (const sessionID of dirty) {
      const entry = store.get(sessionID)
      if (entry === undefined) continue // evicted before flush; retention converges the database
      const live = entry.usage.live
      rows.push({
        sessionID,
        lastActiveAt: entry.lastActiveAt,
        ...(live !== undefined ? { usage: { ...live.tokens, capturedAt: live.capturedAt } } : {}),
        record: { snapshots: entry.snapshots, errors: entry.errors },
      })
    }
    dirty.clear()
    return rows
  }

  const flush = async (): Promise<void> => {
    if (flushInFlight !== undefined) return flushInFlight
    if (status !== "active") return
    if (disposed && !disposing) return
    const rows = collect()
    if (rows.length === 0) return
    const shouldMaintain = now() - lastMaintenanceTrigger >= maintenanceIntervalMs
    if (shouldMaintain) lastMaintenanceTrigger = now()
    flushInFlight = (async () => {
      try {
        const result = await request<PersistFlushResult>({ kind: "flush", location: loc, sessions: rows, maintenance: shouldMaintain })
        flushes += 1
        flushedSessions += result.written
        lastFlushAt = now()
        writtenRawBytes += result.rawBytes
        writtenCompressedBytes += result.compressedBytes
        if (result.deletedByMaintenance > 0) void refreshTotalsQuiet()
      } catch {
        flushFailures += 1
        // Memory remains the source of truth: restore the dirty marks this
        // batch consumed so the debounced retry actually re-writes them.
        for (const row of rows) dirty.add(row.sessionID)
        schedule()
      } finally {
        flushInFlight = undefined
        // Anything dirtied during the in-flight batch (or restored by a
        // failure) goes through the debounced scheduler - flushNow flushes
        // the currently pending batch, it never chases new marks (a caller
        // draining with a late responder must not deadlock).
        if (!disposed && !disposing && dirty.size > 0) schedule()
      }    })()
    return flushInFlight
  }

  const refreshTotalsQuiet = async (): Promise<void> => {
    try {
      workerHealth = await request<PersistHealthResult>({ kind: "health" })
    } catch {
      // Fixed code already recorded; cached totals stay stale.
    }
  }

  const health = (): PersistenceHealth => {
    const mode: PersistenceHealth["mode"] = status === "disabled" || backend === undefined ? "none" : "sqlite-worker"
    return {
      status,
      mode,
      ...(backend !== undefined ? { directory } : {}),
      ...(initInfo?.dbPath !== undefined ? { dbPath: initInfo.dbPath } : {}),
      ...(initInfo?.engine !== undefined ? { engine: initInfo.engine } : {}),
      ...(lastErrorCode !== undefined ? { lastErrorCode } : {}),
      ...(lastErrorAt !== undefined ? { lastErrorAt } : {}),
      flushes,
      flushFailures,
      flushedSessions,
      ...(lastFlushAt !== undefined ? { lastFlushAt } : {}),
      dirtySessions: dirty.size,
      hydratedSessions,
      ...(hydratedAt !== undefined ? { hydratedAt } : {}),
      retention: {
        maxAgeMs: options.budgets.maxAgeMs,
        byteBudgetBytes: options.budgets.byteBudgetBytes,
        maxSessionsPerLocation: options.budgets.maxSessionsPerLocation,
      },
      ...(workerHealth !== undefined
        ? {
            totals: {
              locations: workerHealth.locations,
              sessions: workerHealth.sessions,
              snapshots: workerHealth.snapshots,
              fileBytes: workerHealth.fileBytes,
              payloadBytes: workerHealth.payloadBytes,
              rawBytes: workerHealth.rawBytes,
              ...(workerHealth.rawBytes > 0 ? { compressionRatio: Math.round((workerHealth.rawBytes / Math.max(1, workerHealth.payloadBytes)) * 100) / 100 } : {}),
            },
          }
        : writtenCompressedBytes > 0
          ? {
              totals: {
                locations: 0,
                sessions: 0,
                snapshots: 0,
                fileBytes: 0,
                payloadBytes: writtenCompressedBytes,
                rawBytes: writtenRawBytes,
                compressionRatio: Math.round((writtenRawBytes / writtenCompressedBytes) * 100) / 100,
              },
            }
          : {}),
    }
  }

  const unavailableStats = (reason: string): GlobalStatsPayload => ({
    version: 1,
    available: false,
    reason,
    generatedAt: now(),
    coverage: "captured-sessions",
    totals: { locations: 0, sessions: 0, snapshots: 0, payloadBytes: 0, rawBytes: 0 },
    context: { sessionsWithSnapshots: 0, avgLatestEstimatedInputTokens: 0, peakEstimatedInputTokens: 0, perModel: [] },
    sessions: [],
    locations: [],
    retention: {
      byteBudgetBytes: options.budgets.byteBudgetBytes,
      maxAgeMs: options.budgets.maxAgeMs,
      maxSessionsPerLocation: options.budgets.maxSessionsPerLocation,
      sessions: 0,
      snapshots: 0,
    },
    notes: GLOBAL_STATS_NOTES,
  })

  const init = new Promise<void>(resolve => {
    try {
      backend = options.backend?.() ?? new RealWorkerBackend(options.workerPath ?? join(dirname(fileURLToPath(import.meta.url)), "persist-worker.ts"))
    } catch {
      status = "disabled"
      recordError("worker-spawn-failed")
      resolve()
      return
    }
    backend.onMessage(handleResponse)
    request<PersistInitResult>({ kind: "init", dbDirectory: directory, location: loc, budgets: options.budgets })
      .then(result => {
        initInfo = result
        status = "active"
        if (result.recoveredFromCorruption) recordError("db-corrupt")
      })
      .catch(() => {
        status = "degraded"
      })
      .finally(() => resolve())
  })

  const persistence: Persistence = {
    location: loc,
    markDirty(sessionID) {
      if (disposed || disposing || status !== "active" || typeof sessionID !== "string" || sessionID.length === 0) return
      dirty.add(sessionID)
      schedule()
    },
    async hydrate() {
      if (hydrated || disposed) return
      hydrated = true
      await init
      if (status !== "active") return
      try {
        const result = await request<PersistHydrateResult>({ kind: "hydrate", locationKey: loc.key })
        let applied = 0
        // Rows arrive newest-first; the store refuses entries already captured
        // live, so the load-vs-live race always resolves to the newest data.
        for (const session of result.sessions) {
          if (store.hydrateRecord(session)) applied += 1
        }
        hydratedSessions = applied
        hydratedAt = now()
      } catch {
        // Hydration failure is non-fatal: fresh captures continue; the code
        // is already recorded for diagnostics.
      }
    },
    async flushNow() {
      await init
      // Flush the currently pending batch; follow-up marks are picked up by
      // the debounced scheduler (see flush()'s finally block).
      await flush()
    },
    async globalStats(topN) {
      await init
      if (status !== "active") return unavailableStats(status === "degraded" ? (lastErrorCode ?? "query-failed") : "disabled")
      try {
        return await request<GlobalStatsPayload>({ kind: "globalStats", topN })
      } catch (failure) {
        return unavailableStats((failure as PersistFailure).code)
      }
    },
    health,
    async refreshHealth() {
      await init
      if (status === "active") await refreshTotalsQuiet()
      return health()
    },
    async dispose(timeoutMs = persistDefaults.disposeTimeoutMs) {
      if (disposed) return
      disposing = true // allow the final flush, block new work
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      // Flush the durable queue, bounded so a stuck worker can never hang
      // cleanup. Drain explicitly (one batch per iteration) until clean.
      try {
        await Promise.race([
          (async () => {
            for (let i = 0; i < 100; i += 1) {
              await flush()
              if (dirty.size === 0 && flushInFlight === undefined) return
            }
          })(),
          new Promise<void>(resolve => {
            const guard = setTimeout(resolve, timeoutMs)
            guard.unref?.()
          }),
        ])
      } catch {
        // Fixed code already recorded.
      }
      disposed = true
      for (const waiter of pending.values()) clearTimeout(waiter.timer)
      pending.clear()
      const backendRef = backend
      backend = undefined
      if (backendRef !== undefined) {
        try {
          await Promise.race([
            backendRef.terminate(),
            new Promise<void>(resolve => {
              const guard = setTimeout(resolve, 1_000)
              guard.unref?.()
            }),
          ])
        } catch {
          // Termination is best effort.
        }
      }
    },
  }
  return persistence
}
