/**
 * Message protocol shared by the main-thread persistence manager
 * (persist.ts) and the storage worker (persist-worker.ts).
 *
 * Everything crossing this boundary is aggregate metadata: keys, sizes,
 * counts, estimates, and the already content-free Analysis snapshots. No raw
 * prompt/message/tool content and no free-form error strings ever enter
 * these messages (the worker maps driver errors to the fixed
 * PERSIST_ERROR_CODES vocabulary before replying).
 */
import type { PersistErrorCode } from "./error-codes.ts"
import type { GlobalStatsPayload } from "./types.ts"

/** Canonical per-location identity: the (canonical) directory plus optional workspace. */
export interface PersistLocation {
  /** `directory` or `directory#workspaceID` - the per-location isolation key. */
  readonly key: string
  readonly directory: string
  readonly workspaceID?: string
}

export interface PersistBudgets {
  /** Per-location session-row cap mirrored from the in-memory store. */
  readonly maxSessionsPerLocation: number
  /** Rows older than this (by last activity) are swept by maintenance. */
  readonly maxAgeMs: number
  /** Total compressed payload budget for the whole database. */
  readonly byteBudgetBytes: number
}

/** One session's flush input: refs to immutable in-memory state plus ephemeral bits. */
export interface PersistFlushRow {
  readonly sessionID: string
  readonly lastActiveAt: number
  /** Latest cumulative provider-reported usage (replace-not-sum source of truth), if observed. */
  readonly usage?: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cacheRead: number; readonly cacheWrite: number; readonly capturedAt: number }
  /**
   * The persisted aggregate: snapshot history (Analysis objects, content-free)
   * and the closed-vocabulary error record. Sent as a plain object; the
   * worker owns stringify + gzip + BLOB write, so the main thread never
   * serializes or compresses on the capture path.
   */
  readonly record: {
    readonly snapshots: readonly unknown[]
    readonly errors: { count: number; lastAt?: number; lastCode?: string }
  }
}

export interface PersistHydratedSession {
  readonly sessionID: string
  readonly lastActiveAt: number
  readonly snapshots: readonly unknown[]
  readonly errors: { count: number; lastAt?: number; lastCode?: string }
}

// ---------------------------------------------------------------------------
// Requests (main -> worker). Exactly one `id` in flight per request; the
// worker processes messages strictly FIFO, which preserves per-session
// ordering across flushes.
// ---------------------------------------------------------------------------

export interface PersistInitRequest {
  readonly kind: "init"
  readonly id: number
  readonly dbDirectory: string
  readonly location: PersistLocation
  readonly budgets: PersistBudgets
}

export interface PersistHydrateRequest {
  readonly kind: "hydrate"
  readonly id: number
  readonly locationKey: string
}

export interface PersistFlushRequest {
  readonly kind: "flush"
  readonly id: number
  readonly location: PersistLocation
  readonly sessions: readonly PersistFlushRow[]
  /** Run (throttled) retention/byte-budget maintenance inside the same transaction. */
  readonly maintenance: boolean
}

export interface PersistGlobalStatsRequest {
  readonly kind: "globalStats"
  readonly id: number
  readonly topN: number
}

export interface PersistHealthRequest {
  readonly kind: "health"
  readonly id: number
}

export type PersistRequest =
  | PersistInitRequest
  | PersistHydrateRequest
  | PersistFlushRequest
  | PersistGlobalStatsRequest
  | PersistHealthRequest

// ---------------------------------------------------------------------------
// Responses (worker -> main): `{ ok: true, result }` or `{ ok: false, code }`.
// ---------------------------------------------------------------------------

export interface PersistInitResult {
  readonly dbPath: string
  readonly engine: "bun:sqlite" | "node:sqlite"
  readonly recoveredFromCorruption: boolean
  readonly schemaVersion: number
}

export interface PersistHydrateResult {
  readonly sessions: readonly PersistHydratedSession[]
  /** Rows skipped because their stored payload failed validation. */
  readonly skipped: number
}

export interface PersistFlushResult {
  readonly written: number
  readonly rawBytes: number
  readonly compressedBytes: number
  readonly maintenanceRan: boolean
  readonly deletedByMaintenance: number
}

export interface PersistHealthResult {
  readonly dbPath: string
  readonly engine: string
  /** Database file + WAL size on disk, in bytes. */
  readonly fileBytes: number
  readonly locations: number
  readonly sessions: number
  readonly snapshots: number
  readonly payloadBytes: number
  readonly rawBytes: number
  readonly lastMaintenanceAt?: number
  readonly lastMaintenanceDeleted?: number
}

export type PersistResponse =
  | ({ readonly id: number; readonly ok: true } & (
      | { readonly kind: "init"; readonly result: PersistInitResult }
      | { readonly kind: "hydrate"; readonly result: PersistHydrateResult }
      | { readonly kind: "flush"; readonly result: PersistFlushResult }
      | { readonly kind: "globalStats"; readonly result: GlobalStatsPayload }
      | { readonly kind: "health"; readonly result: PersistHealthResult }
    ))
  | { readonly id: number; readonly ok: false; readonly code: PersistErrorCode }
