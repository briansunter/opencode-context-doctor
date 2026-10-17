/**
 * OpenCode V2 server plugin: observational context analytics.
 *
 * What this plugin does:
 * - Observes the `session.hook("context")` event (the assembled system
 *   prompt, messages, tools, and model of the *primary agent loop*) and
 *   records aggregate, content-free estimates per session.
 * - Tracks provider-reported token usage from the public event stream,
 *   filtered to this plugin instance's location (`session.usage.updated` is
 *   cumulative and replaces prior values; `session.usage.recorded` entries
 *   are auxiliary and never summed in).
 * - Exposes a typed RPC (`rpc.ts`) for the TUI: session list + full report.
 *
 * What this plugin never does:
 * - Mutate outgoing requests (the hook callback only reads its event).
 * - Store raw content: only keys, sizes, counts, and estimates are kept.
 * - Make remote calls (no tokenizers, no telemetry).
 * - Call `ctx.tool.list()` (the full catalog) as a substitute for the hook's
 *   direct per-request tool snapshot.
 */
import { Plugin } from "@opencode/plugin"
import { analyzeContextEvent } from "./analytics.ts"
import { buildReported, findContextWindow } from "./enrich.ts"
import { HOOK_ERROR_CODES } from "./error-codes.ts"
import { locationMatches } from "./location.ts"
import { ContextDoctor } from "./rpc.ts"
import { buildReportPayload } from "./report.ts"
import { createPersistence, persistDefaults } from "./persist.ts"
import { createSnapshotStore } from "./store.ts"
import { GLOBAL_STATS_NOTES } from "./types.ts"
import { applyAuxiliary, applyCumulative, classifyUsageEvent, summarizeDurableUsage, USAGE_NOTES } from "./usage.ts"

export interface ResolvedOptions {
  readonly maxSessions: number
  readonly maxSnapshotsPerSession: number
  readonly sessionIdleMs: number
  /** MCP server-name cache refresh interval; 0 disables periodic refresh. */
  readonly mcpRefreshMs: number
  readonly maxRankedTools: number
  readonly maxLargestMessages: number
  /** Disk persistence (default on). */
  readonly persist: boolean
  /** Overrides the default user state directory for this plugin's own database. */
  readonly storageDirectory?: string
  readonly persistMaxAgeMs: number
  readonly persistByteBudgetBytes: number
  readonly persistDebounceMs: number
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function parseOptions(raw: unknown): ResolvedOptions {
  const options = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    maxSessions: clamp(options.maxSessions, 1, 500, 50),
    maxSnapshotsPerSession: clamp(options.maxSnapshotsPerSession, 1, 200, 20),
    sessionIdleMs: clamp(options.sessionIdleMs, 1_000, 2_592_000_000, 24 * 60 * 60 * 1000),
    mcpRefreshMs: clamp(options.mcpRefreshMs, 0, 3_600_000, 60_000),
    maxRankedTools: clamp(options.maxRankedTools, 1, 50, 12),
    maxLargestMessages: clamp(options.maxLargestMessages, 1, 20, 5),
    persist: options.persist !== false,
    ...(typeof options.storageDirectory === "string" && options.storageDirectory.length > 0
      ? { storageDirectory: options.storageDirectory }
      : {}),
    persistMaxAgeMs: clamp(options.persistMaxAgeMs, 3_600_000, 365 * 24 * 60 * 60 * 1000, persistDefaults.maxAgeMs),
    persistByteBudgetBytes: clamp(options.persistByteBudgetBytes, 1_048_576, 1_073_741_824, persistDefaults.byteBudgetBytes),
    persistDebounceMs: clamp(options.persistDebounceMs, 100, 60_000, persistDefaults.debounceMs),
  }
}

/** Defensive extraction of per-step assistant usage from session.context messages. */
function extractAssistantUsage(message: unknown): { tokens?: unknown; createdAt?: number; model?: string } | undefined {
  if (typeof message !== "object" || message === null) return undefined
  const m = message as { type?: unknown; tokens?: unknown; time?: { created?: unknown } | null; model?: { providerID?: unknown; id?: unknown } | null }
  if (m.type !== "assistant") return undefined
  const providerID = typeof m.model?.providerID === "string" ? m.model.providerID : ""
  const modelID = typeof m.model?.id === "string" ? m.model.id : ""
  return {
    tokens: m.tokens,
    createdAt: typeof m.time?.created === "number" ? m.time.created : 0,
    model: providerID && modelID ? `${providerID}/${modelID}` : "",
  }
}

/** Prefer the host's canonical project directory when it provides one. */
function resolveCanonicalDirectory(location: unknown): string {
  const info = location as { directory?: unknown; project?: { canonical?: unknown } | null } | null | undefined
  if (typeof info?.project?.canonical === "string" && info.project.canonical.length > 0) return info.project.canonical
  return typeof info?.directory === "string" && info.directory.length > 0 ? info.directory : ""
}

export default Plugin.define({
  id: "context-doctor",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const store = createSnapshotStore({
      maxSessions: options.maxSessions,
      maxSnapshotsPerSession: options.maxSnapshotsPerSession,
      sessionIdleMs: options.sessionIdleMs,
    })

    // --- disk persistence (own SQLite database, worker-thread only) ---
    // The hook path only ever calls markDirty (O(1)); serialization,
    // compression, and all SQLite statements run in the worker. Hydration
    // is async and live captures always win the load-vs-live race.
    const canonicalDirectory = resolveCanonicalDirectory(ctx.location)
    const workspaceID = (ctx.location as { workspaceID?: unknown }).workspaceID
    const persistence = options.persist
      ? createPersistence(store, {
          directory: canonicalDirectory,
          ...(typeof workspaceID === "string" && workspaceID.length > 0 ? { workspaceID } : {}),
          ...(options.storageDirectory !== undefined ? { storageDirectory: options.storageDirectory } : {}),
          budgets: {
            maxSessionsPerLocation: options.maxSessions,
            maxAgeMs: options.persistMaxAgeMs,
            byteBudgetBytes: options.persistByteBudgetBytes,
          },
          debounceMs: options.persistDebounceMs,
        })
      : undefined
    void persistence?.hydrate()

    // MCP server names for the heuristic tool grouping. The context hook
    // itself must stay cheap and synchronous, so names come from a bounded
    // cache refreshed here and periodically (registry reads, not connects).
    let mcpServerNames: readonly string[] = []
    const refreshMcpNames = async (): Promise<void> => {
      try {
        const output = await ctx.mcp.list()
        const data = (output as { data?: unknown }).data
        if (Array.isArray(data)) {
          mcpServerNames = data
            .map(server => (server && typeof server === "object" ? (server as { name?: unknown }).name : undefined))
            .filter((name): name is string => typeof name === "string" && name.length > 0)
        }
      } catch {
        // Keep the previous cache; grouping degrades to "other".
      }
    }
    // Best-effort initial refresh, bounded so setup cannot hang on it.
    await Promise.race([refreshMcpNames(), new Promise<void>(resolve => setTimeout(resolve, 2_000))])

    let rpcDispose: (() => Promise<void>) | undefined
    const emitCaptured = (input: { sessionID: string; capturedAt: number; estimatedInputTokens: number }): void => {
      if (rpcDispose === undefined) return
      void rpcRegistration.events
        .emit("captured", input)
        .catch(() => {})
    }

    // --- public event stream: reported usage (location-filtered) ---
    const controller = new AbortController()
    const handleEvent = (event: unknown): void => {
      const e = event as { type?: unknown; created?: unknown; location?: unknown; data?: unknown }
      if (e?.type !== "session.usage.updated" && e?.type !== "session.usage.recorded") return
      // Every location's plugin sees every public event; only accept our own.
      if (!locationMatches(e.location, ctx.location)) return
      const classified = classifyUsageEvent(e as { type: string; created?: number; data?: unknown })
      if (classified.kind === "ignored" || classified.tokens === undefined) return
      const sessionID = classified.sessionID ?? ""
      const entry = store.get(sessionID)
      if (!entry) return // session ownership: only sessions this location tracks
      const at = typeof e.created === "number" ? e.created : Date.now()
      const next =
        classified.kind === "cumulative"
          ? applyCumulative(entry.usage, classified.tokens, at)
          : applyAuxiliary(entry.usage, classified.source ?? "unknown", classified.tokens, at)
      if (next !== entry.usage) {
        entry.usage = next
        // Only re-persist when something actually changed (applyCumulative
        // keeps the old object for stale events).
        persistence?.markDirty(sessionID)
      }
    }
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            handleEvent(event)
          } catch {
            // A malformed event must never break the subscription loop.
          }
        }
      } catch {
        // Aborted or stream failure; cleanup handles teardown.
      }
    })()

    // --- typed RPC for the TUI (location-scoped by the caller) ---
    const rpcRegistration = await ctx.rpc.register(ContextDoctor, {
      list: async () => ({
        sessions: store.list().map(summary => ({
          sessionID: summary.sessionID,
          agent: summary.agent,
          model: summary.model,
          snapshotCount: summary.snapshotCount,
          lastCapturedAt: summary.lastCapturedAt,
          lastEstimatedInputTokens: summary.lastEstimatedInputTokens,
          lastMessageCount: summary.lastMessageCount,
          hookErrorCount: summary.hookErrorCount,
          lastActiveAt: summary.lastActiveAt,
        })),
      }),
      report: async (rawInput, context) => {
        const input = (rawInput ?? {}) as { sessionID?: unknown }
        const sessionID = typeof input.sessionID === "string" && input.sessionID.length > 0 ? input.sessionID : undefined
        if (sessionID === undefined) {
          return context.error("invalid_input", "sessionID is required.", { field: "sessionID" })
        }
        const entry = store.get(sessionID)
        if (!entry || entry.snapshots.length === 0) {
          const instanceDirectory = ctx.location.directory
          if (entry && entry.errors.count > 0) {
            return context.error(
              "unknown_session",
              `No snapshot stored for this session: ${entry.errors.count} capture attempt(s) failed in this plugin instance (location ${instanceDirectory}).`,
              {
                sessionID,
                reason: "hook_error",
                instanceDirectory,
                hookErrorCount: entry.errors.count,
                ...(entry.errors.lastCode !== undefined ? { lastErrorCode: entry.errors.lastCode } : {}),
              },
            )
          }
          return context.error(
            "unknown_session",
            `No context snapshot for this session in this plugin instance (location ${instanceDirectory}) yet. Snapshots are recorded when the agent loop assembles context in this location; sessions in other locations are tracked by their own instance.`,
            { sessionID, reason: "no_capture", instanceDirectory },
          )
        }
        const analysis = entry.snapshots[entry.snapshots.length - 1]!

        // Reported-token enrichment. Each source degrades independently.
        const [messagesResult, modelsResult] = await Promise.allSettled([
          ctx.session.context({ sessionID }, { signal: context.signal }),
          ctx.model.list(undefined, { signal: context.signal }),
        ])
        const messages = messagesResult.status === "fulfilled" ? (messagesResult.value as readonly unknown[]) : []
        const models = modelsResult.status === "fulfilled" ? ((modelsResult.value as { data?: unknown }).data ?? []) : []
        const durable = summarizeDurableUsage(messages, extractAssistantUsage)
        const contextWindowTokens = findContextWindow(
          Array.isArray(models) ? (models as unknown as Parameters<typeof findContextWindow>[0]) : [],
          analysis.model,
        )
        const reported = buildReported({
          estimatedInputTokens: analysis.totals.estimatedInputTokens,
          usage: entry.usage,
          durable,
          contextWindowTokens,
          usageNotes: USAGE_NOTES,
        })

        return buildReportPayload({
          analysis,
          snapshots: entry.snapshots,
          retention: {
            maxSessions: store.maxSessions,
            maxSnapshotsPerSession: store.maxSnapshotsPerSession,
            sessionsTracked: store.list().length,
            snapshotsForSession: entry.snapshots.length,
          },
          errors: {
            hookErrorCount: entry.errors.count,
            ...(entry.errors.lastAt !== undefined ? { lastErrorAt: entry.errors.lastAt } : {}),
            ...(entry.errors.lastCode !== undefined ? { lastErrorCode: entry.errors.lastCode } : {}),
          },
          reported,
        })
      },
      diagnostics: async () => {
        const stats = store.stats()
        const persistenceHealth = persistence === undefined ? undefined : await persistence.refreshHealth()
        return {
          instanceDirectory: ctx.location.directory,
          hookInvocations,
          capturesStored,
          captureFailures,
          ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
          ...(lastFailureCode !== undefined ? { lastFailureCode } : {}),
          sessionsWithSnapshots: stats.sessionsWithSnapshots,
          sessionsWithErrorOnly: stats.sessionsWithErrorOnly,
          maxSessions: store.maxSessions,
          maxSnapshotsPerSession: store.maxSnapshotsPerSession,
          ...(persistenceHealth !== undefined ? { persistence: persistenceHealth } : {}),
        }
      },
      stats: async (rawInput: unknown) => {
        const input = (rawInput ?? {}) as { topN?: unknown }
        const topN =
          typeof input.topN === "number" && Number.isFinite(input.topN)
            ? Math.min(50, Math.max(1, Math.round(input.topN)))
            : 15
        if (persistence === undefined) {
          return {
            version: 1 as const,
            available: false,
            reason: "disabled",
            generatedAt: Date.now(),
            coverage: "captured-sessions" as const,
            totals: { locations: 0, sessions: 0, snapshots: 0, payloadBytes: 0, rawBytes: 0 },
            context: { sessionsWithSnapshots: 0, avgLatestEstimatedInputTokens: 0, peakEstimatedInputTokens: 0, perModel: [] },
            sessions: [],
            locations: [],
            retention: {
              byteBudgetBytes: options.persistByteBudgetBytes,
              maxAgeMs: options.persistMaxAgeMs,
              maxSessionsPerLocation: options.maxSessions,
              sessions: 0,
              snapshots: 0,
            },
            notes: GLOBAL_STATS_NOTES,
          }
        }
        return persistence.globalStats(topN)
      },
    })
    rpcDispose = () => rpcRegistration.dispose()

    // --- the observational context hook ---
    // Instance-level diagnostics counters. They survive store eviction and
    // make the three failure modes distinguishable: hook never firing
    // (invocations 0), hook firing but failing (failures > 0), healthy.
    let hookInvocations = 0
    let capturesStored = 0
    let captureFailures = 0
    let lastFailureAt: number | undefined
    let lastFailureCode: string | undefined

    const hookRegistration = await ctx.session.hook("context", event => {
      hookInvocations += 1
      try {
        // Read-only: never assign to event.system/messages/tools/options.
        const analysis = analyzeContextEvent(event, {
          mcpServers: mcpServerNames,
          maxRankedTools: options.maxRankedTools,
          maxLargestMessages: options.maxLargestMessages,
        })
        const result = store.record(analysis)
        if (result.stored) {
          capturesStored += 1
          // O(1) enqueue only: the disk write happens later in the worker.
          persistence?.markDirty(analysis.sessionID)
          emitCaptured({
            sessionID: analysis.sessionID,
            capturedAt: analysis.capturedAt,
            estimatedInputTokens: analysis.totals.estimatedInputTokens,
          })
        }
      } catch {
        // Fixed code only: error text/stack/cause could echo serialized
        // content, and host log capture would persist it. Nothing is logged.
        captureFailures += 1
        lastFailureAt = Date.now()
        lastFailureCode = HOOK_ERROR_CODES[0]
        // Defensive read: the event itself may be malformed enough that even
        // property access throws; the catch path must never throw to the host.
        let sessionID: unknown
        try {
          sessionID = (event as { sessionID?: unknown } | null | undefined)?.sessionID
        } catch {
          sessionID = undefined
        }
        if (typeof sessionID === "string" && sessionID.length > 0) {
          store.recordError(sessionID, HOOK_ERROR_CODES[0])
          persistence?.markDirty(sessionID)
        }
      }
    })

    let timer: ReturnType<typeof setInterval> | undefined
    if (options.mcpRefreshMs > 0) {
      timer = setInterval(() => {
        void refreshMcpNames()
      }, options.mcpRefreshMs)
      ;(timer as { unref?: () => void }).unref?.()
    }

    return async () => {
      controller.abort()
      if (timer !== undefined) clearInterval(timer)
      // The cleanup hook is awaited by the host: flush the durable queue
      // (bounded) so a plugin reload does not lose the last captures.
      await persistence?.dispose()
      store.dispose()
      void hookRegistration.dispose()
      void rpcDispose?.()
    }
  },
})
