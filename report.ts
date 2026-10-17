/**
 * Pure assembly of the report payload from an analysis snapshot, store
 * bookkeeping, and the reported-usage section. No I/O, no SDK imports.
 */
import type { Analysis } from "./analytics.ts"
import type { ReportedSection } from "./enrich.ts"
import type { ErrorInfo, HistoryPoint, ReportPayload, RetentionInfo } from "./types.ts"

export interface ReportBuildInput {
  readonly analysis: Analysis
  readonly snapshots: readonly Analysis[]
  readonly retention: RetentionInfo
  readonly errors: ErrorInfo
  readonly reported: ReportedSection
  readonly maxHistoryPoints?: number
}

function shareOf(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((value / total) * 10_000) / 10_000
}

export function buildReportPayload(input: ReportBuildInput): ReportPayload {
  const { analysis } = input
  const maxHistory = Math.max(1, input.maxHistoryPoints ?? 8)
  const history: HistoryPoint[] = input.snapshots.slice(-maxHistory).map(snapshot => ({
    capturedAt: snapshot.capturedAt,
    estimatedInputTokens: snapshot.totals.estimatedInputTokens,
    messageCount: snapshot.messages.total,
    systemTokens: snapshot.totals.systemTokens,
    messageTokens: snapshot.totals.messageTokens,
    toolTokens: snapshot.totals.toolTokens,
  }))

  const total = analysis.totals.estimatedInputTokens
  return {
    version: 1,
    sessionID: analysis.sessionID,
    agent: analysis.agent,
    model: analysis.model,
    capturedAt: analysis.capturedAt,
    scope: analysis.scope,
    estimation: analysis.estimation,
    system: analysis.system,
    messages: analysis.messages,
    tools: analysis.tools,
    totals: {
      estimatedInputTokens: total,
      systemTokens: analysis.totals.systemTokens,
      messageTokens: analysis.totals.messageTokens,
      toolTokens: analysis.totals.toolTokens,
      systemShare: shareOf(analysis.totals.systemTokens, total),
      messageShare: shareOf(analysis.totals.messageTokens, total),
      toolShare: shareOf(analysis.totals.toolTokens, total),
    },
    history,
    reported: input.reported,
    retention: input.retention,
    errors: input.errors,
    limits: analysis.limits,
  }
}
