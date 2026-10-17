/**
 * Wire payload types shared by the RPC contract (rpc.ts), the server-side
 * report builder (report.ts), and the TUI renderer (format.ts / tui.tsx).
 *
 * Privacy rule enforced across all of these: keys, sizes, counts, and
 * estimates only - no raw prompt, message, tool-description, or schema
 * content ever crosses this boundary.
 */
import type {
  Analysis,
  ModelRef,
  MessagesAnalysis,
  SystemAnalysis,
  ToolsAnalysis,
} from "./analytics.ts"
import type { ReportedSection } from "./enrich.ts"

export type { ModelRef }

export interface HistoryPoint {
  readonly capturedAt: number
  readonly estimatedInputTokens: number
  readonly messageCount: number
  readonly systemTokens: number
  readonly messageTokens: number
  readonly toolTokens: number
}

export interface RetentionInfo {
  readonly maxSessions: number
  readonly maxSnapshotsPerSession: number
  readonly sessionsTracked: number
  readonly snapshotsForSession: number
}

export interface ErrorInfo {
  readonly hookErrorCount: number
  readonly lastErrorAt?: number
  /** Fixed code from HOOK_ERROR_CODES; never a free-form message. */
  readonly lastErrorCode?: string
}

export interface ReportPayload {
  readonly version: 1
  readonly sessionID: string
  readonly agent: string
  readonly model: ModelRef
  readonly capturedAt: number
  readonly scope: Analysis["scope"]
  readonly estimation: Analysis["estimation"]
  readonly system: SystemAnalysis
  readonly messages: MessagesAnalysis
  readonly tools: ToolsAnalysis
  readonly totals: {
    readonly estimatedInputTokens: number
    readonly systemTokens: number
    readonly messageTokens: number
    readonly toolTokens: number
    readonly systemShare: number
    readonly messageShare: number
    readonly toolShare: number
  }
  readonly history: readonly HistoryPoint[]
  readonly reported: ReportedSection
  readonly retention: RetentionInfo
  readonly errors: ErrorInfo
  readonly limits: readonly string[]
}

export interface SessionSummaryPayload {
  readonly sessionID: string
  readonly agent: string
  readonly model: ModelRef
  readonly snapshotCount: number
  readonly lastCapturedAt: number
  readonly lastEstimatedInputTokens: number
  readonly lastMessageCount: number
  readonly hookErrorCount: number
  readonly lastActiveAt: number
}

export interface ListPayload {
  readonly sessions: readonly SessionSummaryPayload[]
}

/** Why a report has no snapshot: nothing observed in this instance, or captures failed. */
export type NoSnapshotReason = "no_capture" | "hook_error"

export interface DiagnosticsPayload {
  /** Location directory this plugin instance is bound to (RPC routing is location-scoped). */
  readonly instanceDirectory: string
  readonly hookInvocations: number
  readonly capturesStored: number
  readonly captureFailures: number
  readonly lastFailureAt?: number
  /** Fixed code from HOOK_ERROR_CODES; never a free-form message. */
  readonly lastFailureCode?: string
  readonly sessionsWithSnapshots: number
  readonly sessionsWithErrorOnly: number
  readonly maxSessions: number
  readonly maxSnapshotsPerSession: number
  /** Persistence health, retention, and measured compression; present when persistence is enabled. */
  readonly persistence?: PersistenceHealth
}

// ---------------------------------------------------------------------------
// Persistence health (diagnostics) and the cross-location aggregate view
// ---------------------------------------------------------------------------

export type PersistenceStatus = "pending" | "active" | "degraded" | "disabled"

export interface PersistenceHealth {
  readonly status: PersistenceStatus
  readonly mode: "sqlite-worker" | "none"
  /** Root directory of this plugin's own on-disk state (never OpenCode's own data). */
  readonly directory?: string
  readonly dbPath?: string
  readonly engine?: string
  /** Fixed code from PERSIST_ERROR_CODES; never a free-form message. */
  readonly lastErrorCode?: string
  readonly lastErrorAt?: number
  readonly flushes: number
  readonly flushFailures: number
  readonly flushedSessions: number
  readonly lastFlushAt?: number
  /** Sessions currently marked dirty (bounded by the store's session cap). */
  readonly dirtySessions: number
  readonly hydratedSessions: number
  readonly hydratedAt?: number
  readonly retention: {
    readonly maxAgeMs: number
    readonly byteBudgetBytes: number
    readonly maxSessionsPerLocation: number
  }
  /** Database totals from the last successful health query (bounded query). */
  readonly totals?: {
    readonly locations: number
    readonly sessions: number
    readonly snapshots: number
    readonly fileBytes: number
    readonly payloadBytes: number
    readonly rawBytes: number
    /** rawBytes / payloadBytes written so far - measured compression ratio. */
    readonly compressionRatio?: number
  }
}

/** Fixed scope/coverage notes attached to every all-sessions aggregate response. */
export const GLOBAL_STATS_NOTES: readonly string[] = [
  "Coverage is captured sessions only: sessions observed by this plugin on this host while persistence was enabled, within its retention budgets - not a complete history of every OpenCode session.",
  "Context figures are per-session snapshot ESTIMATES (heuristic, local): the average/peak/latest of each session's latest retained context. Repeated snapshots of one session are never summed as token consumption.",
  "Reported usage totals sum each session's LATEST cumulative session.usage.updated value (one per session, replace-not-sum across events). Sessions never observed live while the plugin was loaded contribute no usage.",
  "Tool totals aggregate each session's LATEST retained context snapshot only (schema footprint and transcript I/O): repeated snapshots of the same session are never summed.",
  "Cross-location by design: this aggregate spans every location's captured sessions for this user's plugin. Per-session reports remain location-scoped.",
]

export interface GlobalModelBreakdown {
  readonly providerID: string
  readonly id: string
  readonly sessions: number
  readonly snapshots: number
  readonly avgLatestEstimatedInputTokens: number
  readonly peakEstimatedInputTokens: number
  readonly sumLatestEstimatedInputTokens: number
}

export interface GlobalToolSchemaTotal {
  readonly id: string
  readonly sessions: number
  readonly estimatedTokens: number
}

export interface GlobalToolIOTotal {
  readonly name: string
  readonly sessions: number
  readonly calls: number
  readonly results: number
  readonly estimatedTokens: number
}

export interface GlobalSessionSample {
  readonly sessionID: string
  readonly directory: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly lastCapturedAt: number
  readonly lastActiveAt: number
  readonly snapshotCount: number
  readonly latestEstimatedInputTokens: number
  readonly peakEstimatedInputTokens: number
}

export interface GlobalLocationSummary {
  readonly directory: string
  readonly workspaceID?: string
  readonly sessions: number
  readonly snapshots: number
  readonly lastActiveAt: number
}

export interface GlobalStatsPayload {
  readonly version: 1
  readonly available: boolean
  /** Fixed reason code when unavailable ("disabled" or a PERSIST_ERROR_CODES entry). */
  readonly reason?: string
  readonly generatedAt: number
  readonly coverage: "captured-sessions"
  readonly totals: {
    readonly locations: number
    readonly sessions: number
    readonly snapshots: number
    readonly payloadBytes: number
    readonly rawBytes: number
    readonly firstCapturedAt?: number
    readonly lastCapturedAt?: number
  }
  readonly context: {
    readonly sessionsWithSnapshots: number
    readonly avgLatestEstimatedInputTokens: number
    readonly peakEstimatedInputTokens: number
    readonly perModel: readonly GlobalModelBreakdown[]
  }
  readonly usage?: {
    readonly sessionsWithUsage: number
    readonly capturedThrough?: number
    readonly tokens: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cacheRead: number; readonly cacheWrite: number }
  }
  readonly tools?: {
    readonly schema: readonly GlobalToolSchemaTotal[]
    readonly io: readonly GlobalToolIOTotal[]
  }
  readonly sessions: readonly GlobalSessionSample[]
  readonly locations: readonly GlobalLocationSummary[]
  readonly retention: {
    readonly byteBudgetBytes: number
    readonly maxAgeMs: number
    readonly maxSessionsPerLocation: number
    readonly sessions: number
    readonly snapshots: number
  }
  readonly notes: readonly string[]
}

export interface ReportInput {
  readonly sessionID: string
}

export interface CapturedEventData {
  readonly sessionID: string
  readonly capturedAt: number
  readonly estimatedInputTokens: number
}
