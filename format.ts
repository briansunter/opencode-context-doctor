/**
 * Deterministic plain-text rendering of the report for the TUI dialog.
 * Pure functions only; the renderer (tui.tsx) just displays these lines.
 *
 * Modes: "short" (one-screen summary), "detailed" (everything),
 * "tools" (schema footprint + per-tool transcript I/O). `lastN` bounds the
 * history section. Estimates and reported numbers are always labeled and
 * never blended; measured totals are shown separately, never used to rescale
 * the estimates (cumulative session usage cannot calibrate a single request
 * snapshot).
 */
import type { GlobalStatsPayload, ListPayload, ReportPayload, SessionSummaryPayload } from "./types.ts"

export type ReportMode = "short" | "detailed" | "tools"

export interface FormatOptions {
  readonly mode?: ReportMode
  /** Show only the last N snapshot history points (bounded by what was captured). */
  readonly lastN?: number
  /** Render the cross-location all-sessions aggregate instead of a session report. */
  readonly stats?: boolean
}

export function parseReportArgs(input: string | undefined): FormatOptions {
  const options: { mode?: ReportMode; lastN?: number; stats?: boolean } = {}
  if (typeof input !== "string") return options
  for (const token of input.trim().split(/\s+/)) {
    if (token === "") continue
    if (token === "short" || token === "detailed" || token === "tools") options.mode = token
    else if (token === "all" || token === "stats") options.stats = true
    else if (/^\d+$/.test(token)) {
      const value = Number.parseInt(token, 10)
      if (Number.isFinite(value) && value >= 1) options.lastN = Math.min(200, value)
    }
    // Unknown tokens are ignored so typos degrade to the default view.
  }
  return options
}

function groupDigits(value: number): string {
  const rounded = Math.round(value)
  const sign = rounded < 0 ? "-" : ""
  const digits = Math.abs(rounded).toString()
  let out = ""
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ","
    out += digits[i]!
  }
  return sign + out
}

export function formatTokens(value: number): string {
  return groupDigits(value)
}

export function formatCompact(value: number): string {
  if (Math.abs(value) >= 100_000) return `${(value / 1000).toFixed(0)}k`
  return groupDigits(value)
}

export function formatPercent(ratio: number | undefined, digits = 1): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "n/a"
  return `${(ratio * 100).toFixed(digits)}%`
}

/** Compact ASCII bar chart: filled portion as #, remainder as dots. */
export function formatBar(ratio: number | undefined, width = 10): string {
  const safe = typeof ratio === "number" && Number.isFinite(ratio) ? ratio : 0
  const clamped = Math.max(0, Math.min(1, safe))
  const filled = Math.round(clamped * width)
  return "#".repeat(filled) + ".".repeat(Math.max(0, width - filled))
}

export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "n/a"
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}Z`
}

export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "--:--:--"
  return new Date(ms).toISOString().slice(11, 19)
}

export function formatModel(ref: ReportPayload["model"]): string {
  const variant = ref.variant ? ` (variant ${ref.variant})` : ""
  return `${ref.providerID}/${ref.id}${variant}`
}

export function formatReportedTokens(tokens: {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}): string {
  return `in ${formatTokens(tokens.input)} · out ${formatTokens(tokens.output)} · reasoning ${formatTokens(tokens.reasoning)} · cache r ${formatTokens(tokens.cacheRead)} / w ${formatTokens(tokens.cacheWrite)}`
}

export function formatSessionSummaryLine(summary: SessionSummaryPayload): string {
  const when = formatClock(summary.lastCapturedAt)
  return `${when} · ${formatCompact(summary.lastEstimatedInputTokens)} tok est · ${summary.lastMessageCount} msg · ${summary.snapshotCount} snap${summary.hookErrorCount > 0 ? ` · ${summary.hookErrorCount} err` : ""}`
}

const HEADING = "── "

function heading(title: string): string {
  return `${HEADING}${title}`
}

export function isHeadingLine(line: string): boolean {
  return line.startsWith(HEADING)
}

function headerLines(report: ReportPayload): string[] {
  return [
    `Context Doctor · session ${report.sessionID}`,
    `captured ${formatTimestamp(report.capturedAt)} · agent ${report.agent} · model ${formatModel(report.model)}`,
    "",
  ]
}

function totalsLines(report: ReportPayload, options: { includeRatios?: boolean } = {}): string[] {
  const total = report.totals.estimatedInputTokens
  const lines = [
    heading("ESTIMATED INPUT (heuristic, local - not a tokenizer)"),
    `  total          ${formatTokens(total).padStart(10)} tok  ${formatBar(1)}  100.0%`,
    `  system prompt  ${formatTokens(report.totals.systemTokens).padStart(10)} tok  ${formatBar(report.totals.systemShare)}  ${formatPercent(report.totals.systemShare).padStart(6)}  (${report.system.parts} parts)`,
    `  messages       ${formatTokens(report.totals.messageTokens).padStart(10)} tok  ${formatBar(report.totals.messageShare)}  ${formatPercent(report.totals.messageShare).padStart(6)}  (${report.messages.total} messages)`,
    `  tool schemas   ${formatTokens(report.totals.toolTokens).padStart(10)} tok  ${formatBar(report.totals.toolShare)}  ${formatPercent(report.totals.toolShare).padStart(6)}  (${report.tools.total} tools, direct request snapshot)`,
  ]
  if (options.includeRatios !== false) {
    lines.push(
      `  ratios: ~${report.estimation.latinCharsPerToken} chars/tok latin · ~${report.estimation.cjkCharsPerToken} chars/tok CJK · remote calls: ${report.estimation.remoteCalls ? "yes" : "none"}`,
    )
  }
  lines.push("")
  return lines
}

function categoryLines(report: ReportPayload): string[] {
  const lines = [heading("MESSAGE CATEGORIES (est)")]
  const total = report.messages.categories.reduce((sum, entry) => sum + entry.estimatedTokens, 0)
  for (const entry of report.messages.categories) {
    const shareOf = total > 0 ? entry.estimatedTokens / total : 0
    lines.push(
      `  ${entry.category.padEnd(14)} ${String(entry.parts).padStart(5)} parts ${formatTokens(entry.estimatedTokens).padStart(9)} tok  ${formatBar(shareOf)}  ${formatPercent(shareOf).padStart(6)}`,
    )
  }
  lines.push("")
  return lines
}

function reportedLines(report: ReportPayload, options: { maxNotes?: number; compact?: boolean } = {}): string[] {
  const lines = [heading("REPORTED USAGE (provider counts - not estimates)")]
  const reported = report.reported
  if (reported.cumulative) {
    lines.push(`  session total: ${formatReportedTokens(reported.cumulative.tokens)}`)
    lines.push(
      `    source ${reported.cumulative.source} · captured ${formatTimestamp(reported.cumulative.capturedAt)} · ${reported.cumulative.ephemeral ? "ephemeral (live event)" : "durable (per-step sum)"}`,
    )
  } else {
    lines.push("  session total: no provider-reported usage available yet")
  }
  if (reported.lastStep) {
    lines.push(`  last completed reply: ${formatReportedTokens(reported.lastStep.tokens)}`)
  }
  if (!options.compact && reported.durableSteps !== undefined) {
    lines.push(`  durable per-step records found: ${reported.durableSteps}`)
  }
  if (!options.compact) {
    for (const auxiliary of reported.auxiliary ?? []) {
      lines.push(`  auxiliary (${auxiliary.source}, never summed): ${formatReportedTokens(auxiliary.tokens)}`)
    }
  }
  if (reported.contextWindowTokens !== undefined) {
    lines.push(`  context window: ${formatTokens(reported.contextWindowTokens)} tok (model.limit.context)`)
    lines.push(
      `  utilization: estimated ${reported.utilizationEstimatedPct !== undefined ? `${reported.utilizationEstimatedPct.toFixed(1)}%` : "n/a"} of the context window (no reported percentage: the latest reply may be from a different model and provider cache accounting differs)`,
    )
  } else {
    lines.push("  context window: unavailable from the model registry")
  }
  const notes = options.maxNotes === undefined ? reported.notes : reported.notes.slice(0, options.maxNotes)
  for (const note of notes) {
    lines.push(`  · ${note}`)
  }
  lines.push("")
  return lines
}

function historyLines(report: ReportPayload, lastN: number | undefined): string[] {
  const points = lastN !== undefined ? report.history.slice(-lastN) : report.history
  if (points.length <= 1) return []
  const lines = [heading(`SNAPSHOT HISTORY (newest last${lastN !== undefined ? ` · last ${points.length}` : ""})`)]
  for (const point of points) {
    lines.push(
      `  ${formatClock(point.capturedAt)}  ${formatTokens(point.estimatedInputTokens).padStart(9)} tok · ${point.messageCount} msg · sys ${formatCompact(point.systemTokens)} · msg ${formatCompact(point.messageTokens)} · tools ${formatCompact(point.toolTokens)}`,
    )
  }
  lines.push("")
  return lines
}

function schemaToolsLines(report: ReportPayload): string[] {
  const lines = [heading("TOOL SCHEMAS (direct per-request definitions; not the full catalog)")]
  lines.push(`  ${report.tools.total} tools · estimated ${formatTokens(report.tools.estimatedTokens)} tok`)
  const rankWidth = String(Math.min(report.tools.ranked.length, 99)).length
  report.tools.ranked.forEach((tool, index) => {
    const group = tool.group.kind === "mcp-server" ? ` [mcp: ${tool.group.name}?]` : ""
    lines.push(
      `  ${String(index + 1).padStart(rankWidth)}. ${tool.id.padEnd(34)} ${formatTokens(tool.estimatedTokens).padStart(8)} tok · schema ${tool.schemaProperties} props / ${formatTokens(tool.schemaCharacters)} chars · desc ${formatTokens(tool.descriptionCharacters)} chars${group}`,
    )
  })
  if (report.tools.groups.length > 1 || report.tools.groups.some(g => g.kind === "mcp-server")) {
    lines.push("  groups (attribution is heuristic):")
    for (const group of report.tools.groups) {
      lines.push(
        `    ${group.name.padEnd(28)} ${String(group.tools).padStart(3)} tools ${formatTokens(group.estimatedTokens).padStart(8)} tok  ${formatBar(group.share)}  ${formatPercent(group.share).padStart(6)}`,
      )
    }
  }
  lines.push(`  note: ${report.tools.attributionNote}`)
  lines.push("")
  return lines
}

function toolIOLines(report: ReportPayload): string[] {
  const lines = [heading("TOOL I/O IN TRANSCRIPT (est; separate from schema footprint)")]
  const io = report.tools.io
  lines.push(`  ${io.totalCalls} calls · ${io.totalResults} results · estimated ${formatTokens(io.estimatedTokens)} tok`)
  if (io.ranked.length === 0) {
    lines.push("  no tool-call or tool-result parts in the current context")
  }
  for (const entry of io.ranked) {
    lines.push(
      `  ${entry.name.padEnd(34)} ${formatTokens(entry.estimatedTokens).padStart(8)} tok · in ${entry.calls}x ${formatTokens(entry.estimatedCallTokens)} / out ${entry.results}x ${formatTokens(entry.estimatedResultTokens)}`,
    )
  }
  lines.push(`  note: ${io.note}`)
  lines.push("")
  return lines
}

function limitsLines(report: ReportPayload, max: number | undefined): string[] {
  const lines = [heading("LIMITS")]
  const seen = new Set<string>()
  const all = [...report.limits, ...report.reported.notes]
  for (const limit of all) {
    if (seen.has(limit)) continue
    seen.add(limit)
  }
  const list = max === undefined ? [...seen] : [...seen].slice(0, max)
  for (const limit of list) {
    lines.push(`  - ${limit}`)
  }
  lines.push("")
  return lines
}

export function formatReportLines(report: ReportPayload, options: FormatOptions = {}): readonly string[] {
  const mode: ReportMode = options.mode ?? "detailed"
  const lines: string[] = [...headerLines(report)]

  if (mode === "short") {
    lines.push(...totalsLines(report, { includeRatios: false }))
    lines.push(...categoryLines(report))
    lines.push(...reportedLines(report, { maxNotes: 2, compact: true }))
    lines.push(...limitsLines(report, 2))
    return lines
  }

  if (mode === "tools") {
    lines.push(...schemaToolsLines(report))
    lines.push(...toolIOLines(report))
    lines.push(...limitsLines(report, undefined))
    return lines
  }

  // detailed
  lines.push(...totalsLines(report))
  lines.push(heading("SYSTEM PROMPT"))
  lines.push(
    `  ${report.system.parts} parts · ${formatTokens(report.system.characters)} chars · ${report.system.cacheHintedParts} cache-hinted · estimated ${formatTokens(report.system.estimatedTokens)} tok`,
  )
  lines.push(`  provenance: ${report.system.provenance.note}`)
  lines.push("")
  lines.push(...categoryLines(report))
  lines.push(heading("MESSAGES BY ROLE"))
  for (const role of report.messages.byRole) {
    lines.push(
      `  ${role.role.padEnd(9)} ${String(role.messages).padStart(4)} msg ${String(role.parts).padStart(6)} parts ${formatTokens(role.estimatedTokens).padStart(9)} tok ${formatTokens(role.characters).padStart(10)} chars`,
    )
  }
  lines.push("")
  lines.push(heading("MESSAGES BY PART TYPE"))
  for (const part of report.messages.byPartType) {
    const suffix = part.countedOnly ? `  (counted only${part.note ? `: ${part.note}` : ""})` : ""
    lines.push(
      `  ${part.partType.padEnd(12)} ${String(part.parts).padStart(5)} parts ${formatTokens(part.estimatedTokens).padStart(9)} tok${suffix}`,
    )
  }
  if (report.messages.largest.length > 0) {
    lines.push("")
    lines.push(heading("LARGEST MESSAGES (est)"))
    for (const message of report.messages.largest) {
      lines.push(
        `  #${message.index} ${message.role.padEnd(9)} ${formatTokens(message.estimatedTokens).padStart(9)} tok · ${message.parts} parts · ${formatTokens(message.characters)} chars`,
      )
    }
  }
  lines.push("")
  lines.push(...schemaToolsLines(report))
  lines.push(...toolIOLines(report))
  lines.push(...reportedLines(report))
  lines.push(...historyLines(report, options.lastN))
  lines.push(heading("RETENTION & ERRORS"))
  lines.push(
    `  sessions tracked ${report.retention.sessionsTracked}/${report.retention.maxSessions} · snapshots ${report.retention.snapshotsForSession}/${report.retention.maxSnapshotsPerSession} (this session) · hook errors ${report.errors.hookErrorCount}`,
  )
  if (report.errors.lastErrorAt !== undefined) {
    lines.push(
      `  last hook error: ${formatTimestamp(report.errors.lastErrorAt)}${report.errors.lastErrorCode ? ` - ${report.errors.lastErrorCode}` : ""}`,
    )
  }
  lines.push("")
  lines.push(...limitsLines(report, undefined))
  return lines
}

export function formatListLines(list: ListPayload): readonly string[] {
  const lines: string[] = ["Context Doctor · tracked sessions (this location)"]
  if (list.sessions.length === 0) {
    lines.push("  none yet - snapshots are taken when the agent loop assembles context")
    return lines
  }
  for (const session of list.sessions) {
    lines.push(`  ${session.sessionID} · ${session.agent} · ${formatSessionSummaryLine(session)}`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Cross-location all-sessions aggregate
// ---------------------------------------------------------------------------

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${Math.round(value)} B`
}

export function formatStatsLines(stats: GlobalStatsPayload): readonly string[] {
  const lines: string[] = ["Context Doctor · all sessions (cross-location aggregate)", ""]
  if (!stats.available) {
    lines.push(heading("UNAVAILABLE"))
    lines.push(`  reason: ${stats.reason ?? "unknown"}`)
    lines.push("  per-session reports continue to work from memory; disk persistence is not active.")
    lines.push("")
    return lines
  }
  lines.push(
    `  coverage: captured sessions across ${stats.totals.locations} location${stats.totals.locations === 1 ? "" : "s"} · ${formatTimestamp(stats.generatedAt)}`,
  )
  lines.push(
    `  sessions ${formatTokens(stats.totals.sessions)} · snapshots ${formatTokens(stats.totals.snapshots)} · on-disk payloads ${formatBytes(stats.totals.payloadBytes)}`,
  )
  lines.push("")
  lines.push(heading("ESTIMATED CONTEXT (per-session latest snapshot; NEVER summed as consumption)"))
  lines.push(`  avg latest context   ${formatTokens(stats.context.avgLatestEstimatedInputTokens).padStart(10)} tok`)
  lines.push(`  peak per-session est ${formatTokens(stats.context.peakEstimatedInputTokens).padStart(10)} tok`)
  for (const model of stats.context.perModel) {
    lines.push(
      `  ${`${model.providerID}/${model.id}`.padEnd(30)} ${String(model.sessions).padStart(4)} ses · avg ${formatCompact(model.avgLatestEstimatedInputTokens)} · peak ${formatCompact(model.peakEstimatedInputTokens)} tok`,
    )
  }
  lines.push("")
  if (stats.usage !== undefined) {
    lines.push(heading("REPORTED USAGE TOTALS (latest cumulative per session - not estimates)"))
    lines.push(`  sessions with observed usage: ${formatTokens(stats.usage.sessionsWithUsage)}`)
    lines.push(`  totals: ${formatReportedTokens(stats.usage.tokens)}`)
    lines.push("")
  }
  if (stats.tools !== undefined) {
    lines.push(heading("TOOLS ACROSS SESSIONS (each session's latest retained context only)"))
    if (stats.tools.schema.length > 0) {
      lines.push("  schema footprint:")
      for (const tool of stats.tools.schema) {
        lines.push(`    ${tool.id.padEnd(34)} ${formatTokens(tool.estimatedTokens).padStart(8)} tok · in ${tool.sessions} session${tool.sessions === 1 ? "" : "s"}' latest context`)
      }
    }
    if (stats.tools.io.length > 0) {
      lines.push("  transcript I/O:")
      for (const io of stats.tools.io) {
        lines.push(`    ${io.name.padEnd(34)} ${formatTokens(io.estimatedTokens).padStart(8)} tok · ${io.calls} calls / ${io.results} results (latest contexts)`)
      }
    }
    lines.push("")
  }
  if (stats.sessions.length > 0) {
    lines.push(heading(`NEWEST SESSIONS (top ${stats.sessions.length})`))
    for (const session of stats.sessions) {
      lines.push(
        `  ${session.sessionID} · ${session.directory || "?"} · ${session.agent} · ${formatCompact(session.latestEstimatedInputTokens)} tok est · peak ${formatCompact(session.peakEstimatedInputTokens)} · ${session.snapshotCount} snap`,
      )
    }
    lines.push("")
  }
  if (stats.locations.length > 0) {
    lines.push(heading("LOCATIONS"))
    for (const location of stats.locations) {
      lines.push(
        `  ${location.directory || "?"}${location.workspaceID !== undefined ? ` #${location.workspaceID}` : ""} · ${location.sessions} sessions · ${location.snapshots} snapshots · active ${formatClock(location.lastActiveAt)}`,
      )
    }
    lines.push("")
  }
  lines.push(heading("RETENTION"))
  lines.push(
    `  byte budget ${formatBytes(stats.retention.byteBudgetBytes)} · max age ${Math.round(stats.retention.maxAgeMs / 3_600_000)}h · per-location cap ${stats.retention.maxSessionsPerLocation} sessions`,
  )
  lines.push("")
  lines.push(heading("SCOPE & LIMITS"))
  for (const note of stats.notes) {
    lines.push(`  - ${note}`)
  }
  lines.push("")
  return lines
}
