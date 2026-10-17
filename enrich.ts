/**
 * Reported-token enrichment: merges live cumulative usage, the durable
 * per-step fallback, and the model's context-window limit into the report's
 * "reported" section. Estimated and reported numbers never mix.
 */
import type { ModelRef } from "./analytics.ts"
import type { CumulativeUsage, DurableUsageSummary, ReportedTokens, SessionUsage } from "./usage.ts"

export interface ModelInfoLike {
  readonly providerID: string
  readonly id: string
  readonly modelID?: string
  readonly limit?: { readonly context?: number }
}

/**
 * Find the model's context-window limit. `ctx.model.list()` is a registry
 * read; matches the hook's model ref against `modelID` (canonical) or `id`
 * (effective, may encode a variant).
 */
export function findContextWindow(models: readonly ModelInfoLike[], ref: ModelRef): number | undefined {
  const match = models.find(
    m => m && m.providerID === ref.providerID && (m.modelID === ref.id || m.id === ref.id),
  )
  const limit = match?.limit?.context
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined
}

export interface ReportedSection {
  readonly available: boolean
  /** Preferred cumulative total: live event snapshot when present, otherwise the durable per-step sum. */
  readonly cumulative?: {
    readonly tokens: ReportedTokens
    readonly capturedAt: number
    readonly source: "session.usage.updated" | "session.context-sum"
    readonly ephemeral: boolean
  }
  readonly durableSteps?: number
  readonly lastStep?: { readonly tokens: ReportedTokens; readonly createdAt: number; readonly model: string }
  readonly auxiliary?: readonly { readonly source: string; readonly capturedAt: number; readonly tokens: ReportedTokens }[]
  readonly contextWindowTokens?: number
  readonly contextWindowSource: "model.limit.context" | "none"
  readonly utilizationEstimatedPct?: number
  readonly notes: readonly string[]
}

function pct(numerator: number, denominator: number): number | undefined {
  if (!(denominator > 0) || !Number.isFinite(numerator)) return undefined
  return Math.round((numerator / denominator) * 1000) / 10
}

export interface BuildReportedInput {
  readonly estimatedInputTokens: number
  readonly usage: SessionUsage
  readonly durable: DurableUsageSummary
  readonly contextWindowTokens: number | undefined
  readonly usageNotes: readonly string[]
}

export function buildReported(input: BuildReportedInput): ReportedSection {
  const { estimatedInputTokens, usage, durable, contextWindowTokens } = input
  const live: CumulativeUsage | undefined = usage.live
  const preferLive = live !== undefined
  const cumulativeSource = preferLive ? ("session.usage.updated" as const) : ("session.context-sum" as const)
  const cumulativeTokens = preferLive ? live.tokens : durable.total
  const cumulativeCapturedAt = preferLive ? live.capturedAt : (durable.last?.createdAt ?? 0)
  const hasCumulative = durable.steps > 0 || preferLive

  const notes = [...input.usageNotes]
  notes.push(
    "Cumulative session totals span every request in the session; they are not single-request context-window occupancy, so no utilization percentage is derived from them.",
  )
  if (preferLive) {
    notes.push("Using the live cumulative total from session.usage.updated (ephemeral).")
  } else if (durable.steps > 0) {
    notes.push("Live cumulative usage has not been observed; using the durable per-step sum from session.context.")
  }
  if (contextWindowTokens === undefined) {
    notes.push("Context-window limit unavailable from the model registry; utilization not computed.")
  }
  if (durable.last) {
    notes.push(
      "The per-step entry is the latest completed assistant reply; it may be from a different model than the current snapshot, may lag it, and providers disagree on cache accounting, so it is shown raw without a utilization percentage.",
    )
  }

  return {
    available: hasCumulative,
    ...(hasCumulative
      ? {
          cumulative: {
            tokens: cumulativeTokens,
            capturedAt: cumulativeCapturedAt,
            source: cumulativeSource,
            ephemeral: preferLive,
          },
        }
      : {}),
    ...(durable.steps > 0 ? { durableSteps: durable.steps } : {}),
    ...(durable.last ? { lastStep: durable.last } : {}),
    ...(usage.auxiliary.length > 0 ? { auxiliary: usage.auxiliary } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    contextWindowSource: contextWindowTokens !== undefined ? "model.limit.context" : "none",
    ...(contextWindowTokens !== undefined ? { utilizationEstimatedPct: pct(estimatedInputTokens, contextWindowTokens) } : {}),
    notes,
  }
}
