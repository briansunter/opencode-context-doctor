/**
 * Cross-location aggregate statistics, computed from indexed metadata rows
 * only (never from compressed snapshot payloads). Runs inside the storage
 * worker on demand - never on the capture path.
 *
 * Anti-double-count rules enforced here:
 * - Each session row carries ONE latest-context sample and ONE peak value;
 *   repeated snapshots of a session are never summed as consumption.
 * - Usage sums each session's latest cumulative value (replace-not-sum events).
 * - Tool totals aggregate each session's latest retained snapshot only.
 */
import type { PersistBudgets } from "./persist-protocol.ts"
import { GLOBAL_STATS_NOTES, type GlobalStatsPayload } from "./types.ts"

/** Indexed session row as materialized by persist-worker.ts (payload BLOB excluded). */
export interface StatsSessionRow {
  readonly location_key: string
  readonly session_id: string
  readonly agent: string
  readonly model_provider: string
  readonly model_id: string
  readonly model_variant: string | null
  readonly first_captured_at: number
  readonly last_captured_at: number
  readonly last_active_at: number
  readonly snapshot_count: number
  readonly latest_estimated_input_tokens: number
  readonly peak_estimated_input_tokens: number
  readonly usage_input: number | null
  readonly usage_output: number | null
  readonly usage_reasoning: number | null
  readonly usage_cache_read: number | null
  readonly usage_cache_write: number | null
  readonly usage_captured_at: number | null
  readonly tools_json: string | null
}

export interface StatsLocationRow {
  readonly key: string
  readonly directory: string
  readonly workspace_id: string | null
  readonly sessions: number
  readonly snapshots: number
  readonly lastActiveAt: number
}

interface ToolEntry {
  sessions: number
  tokens: number
  calls: number
  results: number
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** Parse the compact tools_json columns ({s:[[id,tokens]...], io:[[name,calls,results,tokens]...]}). */
function parseToolsJson(raw: string | null): { schema: [string, number][]; io: [string, number, number, number][] } {
  if (raw === null) return { schema: [], io: [] }
  try {
    const parsed = JSON.parse(raw) as { s?: unknown; io?: unknown }
    const schema = Array.isArray(parsed.s)
      ? parsed.s.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && e.length >= 2)
      : []
    const io = Array.isArray(parsed.io)
      ? parsed.io.filter((e): e is [string, number, number, number] => Array.isArray(e) && typeof e[0] === "string" && e.length >= 4)
      : []
    return { schema, io }
  } catch {
    return { schema: [], io: [] }
  }
}

export interface BuildGlobalStatsOptions {
  readonly topN: number
  readonly budgets: PersistBudgets
  readonly generatedAt: number
  readonly locationCount: number
  readonly payloadBytes: number
  readonly rawBytes: number
  /** sessionID -> canonical location directory (cross-location view is intentional). */
  readonly directoryOfSession: ReadonlyMap<string, string>
  /** Pre-aggregated location summaries (bounded, newest first). */
  readonly locations: readonly import("./types.ts").GlobalLocationSummary[]
}

export function buildGlobalStats(
  sessionRows: readonly StatsSessionRow[],
  options: BuildGlobalStatsOptions,
): GlobalStatsPayload {
  const topN = Math.max(1, Math.min(50, Math.round(options.topN)))
  const sessions = sessionRows.length
  const snapshots = sessionRows.reduce((sum, row) => sum + num(row.snapshot_count), 0)

  let latestSum = 0
  let peak = 0
  let firstCapturedAt: number | undefined
  let lastCapturedAt: number | undefined
  const models = new Map<string, { providerID: string; id: string; sessions: number; snapshots: number; latestSum: number; peak: number }>()
  const usageTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let sessionsWithUsage = 0
  let capturedThrough: number | undefined
  const schemaTotals = new Map<string, ToolEntry>()
  const ioTotals = new Map<string, ToolEntry>()

  for (const row of sessionRows) {
    const latest = num(row.latest_estimated_input_tokens)
    latestSum += latest
    const rowPeak = num(row.peak_estimated_input_tokens)
    if (rowPeak > peak) peak = rowPeak
    const first = num(row.first_captured_at)
    const last = num(row.last_captured_at)
    if (first > 0 && (firstCapturedAt === undefined || first < firstCapturedAt)) firstCapturedAt = first
    if (last > 0 && (lastCapturedAt === undefined || last > lastCapturedAt)) lastCapturedAt = last

    const modelKey = `${row.model_provider}/${row.model_id}`
    const model = models.get(modelKey) ?? { providerID: row.model_provider, id: row.model_id, sessions: 0, snapshots: 0, latestSum: 0, peak: 0 }
    model.sessions += 1
    model.snapshots += num(row.snapshot_count)
    model.latestSum += latest
    if (rowPeak > model.peak) model.peak = rowPeak
    models.set(modelKey, model)

    if (row.usage_captured_at !== null && row.usage_input !== null) {
      sessionsWithUsage += 1
      usageTotals.input += num(row.usage_input)
      usageTotals.output += num(row.usage_output)
      usageTotals.reasoning += num(row.usage_reasoning)
      usageTotals.cacheRead += num(row.usage_cache_read)
      usageTotals.cacheWrite += num(row.usage_cache_write)
      const capturedAt = num(row.usage_captured_at)
      if (capturedAt > 0 && (capturedThrough === undefined || capturedAt > capturedThrough)) capturedThrough = capturedAt
    }

    if (row.tools_json !== null) {
      const { schema, io } = parseToolsJson(row.tools_json)
      for (const [id, tokens] of schema) {
        const entry = schemaTotals.get(id) ?? { sessions: 0, tokens: 0, calls: 0, results: 0 }
        entry.sessions += 1
        entry.tokens += num(tokens)
        schemaTotals.set(id, entry)
      }
      for (const [name, calls, results, tokens] of io) {
        const entry = ioTotals.get(name) ?? { sessions: 0, tokens: 0, calls: 0, results: 0 }
        entry.sessions += 1
        entry.calls += num(calls)
        entry.results += num(results)
        entry.tokens += num(tokens)
        ioTotals.set(name, entry)
      }
    }
  }

  const perModel = [...models.values()]
    .sort((a, b) => b.sessions - a.sessions || b.latestSum - a.latestSum || a.id.localeCompare(b.id))
    .slice(0, topN)
    .map(model => ({
      providerID: model.providerID,
      id: model.id,
      sessions: model.sessions,
      snapshots: model.snapshots,
      avgLatestEstimatedInputTokens: model.sessions > 0 ? Math.round(model.latestSum / model.sessions) : 0,
      peakEstimatedInputTokens: model.peak,
      sumLatestEstimatedInputTokens: model.latestSum,
    }))

  const newestSessions = [...sessionRows]
    .sort((a, b) => num(b.last_active_at) - num(a.last_active_at) || a.session_id.localeCompare(b.session_id))
    .slice(0, topN)
    .map(row => ({
      sessionID: row.session_id,
      directory: options.directoryOfSession.get(row.session_id) ?? "",
      agent: row.agent,
      model: {
        providerID: row.model_provider,
        id: row.model_id,
        ...(row.model_variant !== null && row.model_variant !== undefined ? { variant: row.model_variant } : {}),
      },
      lastCapturedAt: num(row.last_captured_at),
      lastActiveAt: num(row.last_active_at),
      snapshotCount: num(row.snapshot_count),
      latestEstimatedInputTokens: num(row.latest_estimated_input_tokens),
      peakEstimatedInputTokens: num(row.peak_estimated_input_tokens),
    }))

  return {
    version: 1,
    available: true,
    generatedAt: options.generatedAt,
    coverage: "captured-sessions",
    totals: {
      locations: options.locationCount,
      sessions,
      snapshots,
      payloadBytes: options.payloadBytes,
      rawBytes: options.rawBytes,
      ...(firstCapturedAt !== undefined ? { firstCapturedAt } : {}),
      ...(lastCapturedAt !== undefined ? { lastCapturedAt } : {}),
    },
    context: {
      sessionsWithSnapshots: sessions,
      avgLatestEstimatedInputTokens: sessions > 0 ? Math.round(latestSum / sessions) : 0,
      peakEstimatedInputTokens: peak,
      perModel,
    },
    ...(sessionsWithUsage > 0
      ? {
          usage: {
            sessionsWithUsage,
            ...(capturedThrough !== undefined ? { capturedThrough } : {}),
            tokens: usageTotals,
          },
        }
      : {}),
    ...(schemaTotals.size > 0 || ioTotals.size > 0
      ? {
          tools: {
            schema: [...schemaTotals.entries()]
              .map(([id, entry]) => ({ id, sessions: entry.sessions, estimatedTokens: entry.tokens }))
              .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.id.localeCompare(b.id))
              .slice(0, topN),
            io: [...ioTotals.entries()]
              .map(([name, entry]) => ({ name, sessions: entry.sessions, calls: entry.calls, results: entry.results, estimatedTokens: entry.tokens }))
              .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.name.localeCompare(b.name))
              .slice(0, topN),
          },
        }
      : {}),
    sessions: newestSessions,
    locations: options.locations,
    retention: {
      byteBudgetBytes: options.budgets.byteBudgetBytes,
      maxAgeMs: options.budgets.maxAgeMs,
      maxSessionsPerLocation: options.budgets.maxSessionsPerLocation,
      sessions,
      snapshots,
    },
    notes: GLOBAL_STATS_NOTES,
  }
}
