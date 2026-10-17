/**
 * Pure dashboard view model for the /context-doctor TUI.
 *
 * Everything here is deterministic and renderer-free: layout tiers, elision,
 * aligned tables, KPI rows, bars, and tab plans are computed from the report
 * payloads so the JSX layer (tui.tsx) only maps semantic tones to theme
 * colors. Percentages are always recomputed from raw token counts (the wire
 * payload pre-rounds shares to 4 decimals) and every denominator is explicit:
 *
 * - system/messages/tool-schema shares are fractions of the *estimated input
 *   total* for this snapshot,
 * - message-category shares are fractions of the *message* subtotal,
 * - per-tool schema shares are fractions of the *tool-schema* subtotal,
 * - context utilization is the snapshot estimate over the model registry's
 *   context window (never a provider-reported percentage).
 *
 * No raw prompt/message/tool content exists in the payloads, so no view-model
 * string can leak any; tests assert the marked fixture secret never appears.
 */
import {
  formatClock,
  formatModel,
  formatPercent,
  formatTokens,
  type FormatOptions,
  type ReportMode,
} from "./format.ts"
import type { GlobalStatsPayload, ReportPayload } from "./types.ts"

// ---------------------------------------------------------------------------
// Tabs and dialog plans
// ---------------------------------------------------------------------------

export interface DashboardTab {
  readonly id: string
  readonly title: string
  /** Keyboard digit bound to the tab (1-5). */
  readonly bind: string
}

export interface TabLabel {
  readonly text: string
  readonly active: boolean
  /** Draw the ▌ active marker before this label (single-row bars and digit rows). */
  readonly marker?: boolean
}

/**
 * Tab bar rows for the layout: full titles fit on one row at medium/wide;
 * narrow terminals get a digit row plus the active tab's title underneath.
 */
export function tabBarRows(tabs: readonly DashboardTab[], activeId: string, layout: DashboardLayout): readonly (readonly TabLabel[])[] {
  if (layout.tier !== "narrow") {
    return [tabs.map(tab => ({ text: `${tab.bind} ${tab.title}`, active: tab.id === activeId, marker: true }))]
  }
  return [
    tabs.map(tab => ({ text: tab.bind, active: tab.id === activeId, marker: true })),
    [{ text: tabs.find(tab => tab.id === activeId)?.title ?? "", active: true, marker: false }],
  ]
}

/** Footer hint scaled to the layout tier (never wraps). */
export function footerHint(layout: DashboardLayout): string {
  if (layout.tier === "narrow") return "1-5 tabs · ←/→ · ↑↓ · esc close"
  if (layout.tier === "medium") return "1-5 tabs · ←/→ switch · ↑/↓ scroll · esc close"
  return "1-5 tabs · ←/→ switch · ↑/↓/pgup/pgdn scroll · home/end top/bottom · esc close"
}

export const SESSION_TABS: readonly DashboardTab[] = [
  { id: "overview", title: "Overview", bind: "1" },
  { id: "tools", title: "Tools", bind: "2" },
  { id: "history", title: "History", bind: "3" },
  { id: "usage", title: "Usage", bind: "4" },
  { id: "details", title: "Details", bind: "5" },
]

export const ALL_SESSIONS_TABS: readonly DashboardTab[] = [
  { id: "overview", title: "Overview", bind: "1" },
  { id: "tools", title: "Tools", bind: "2" },
  { id: "sessions", title: "Sessions", bind: "3" },
  { id: "usage", title: "Usage", bind: "4" },
  { id: "details", title: "Details", bind: "5" },
]

export interface SessionDialogPlan {
  readonly scope: "session"
  readonly tabs: readonly DashboardTab[]
  readonly initialTabId: string
  /** Bound on history rows (from the `N` argument). */
  readonly lastN?: number
}

export interface AllSessionsDialogPlan {
  readonly scope: "all"
  readonly tabs: readonly DashboardTab[]
  readonly initialTabId: string
}

/**
 * Map the legacy slash-command arguments onto the dashboard. The arguments
 * keep their meaning: `tools` opens on the Tools tab, `short`/`detailed` (and
 * the default) open on Overview, `N` bounds the history rows. `all`/`stats`
 * never reaches this planner (the flow renders the all-sessions dashboard).
 */
export function sessionDialogPlan(options: FormatOptions): SessionDialogPlan {
  const mode: ReportMode | undefined = options.mode
  return {
    scope: "session",
    tabs: SESSION_TABS,
    initialTabId: mode === "tools" ? "tools" : "overview",
    lastN: options.lastN,
  }
}

export function allSessionsDialogPlan(): AllSessionsDialogPlan {
  return { scope: "all", tabs: ALL_SESSIONS_TABS, initialTabId: "overview" }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type LayoutTier = "narrow" | "medium" | "wide"

export interface DashboardLayout {
  readonly tier: LayoutTier
  /** Max width every generated line must fit into (no horizontal clipping). */
  readonly contentWidth: number
  readonly barWidth: number
  readonly kpiColumns: number
}

/** Dialog chrome (frame + padding) estimate subtracted from the terminal. */
const HORIZONTAL_CHROME = 12

export function layoutFor(terminalWidth: number): DashboardLayout {
  const safe = Number.isFinite(terminalWidth) ? Math.floor(terminalWidth) : 80
  const contentWidth = Math.max(34, Math.min(108, safe - HORIZONTAL_CHROME))
  const tier: LayoutTier = contentWidth >= 84 ? "wide" : contentWidth >= 56 ? "medium" : "narrow"
  return {
    tier,
    contentWidth,
    barWidth: tier === "wide" ? 14 : tier === "medium" ? 10 : 7,
    kpiColumns: tier === "narrow" ? 2 : 4,
  }
}

// ---------------------------------------------------------------------------
// Numbers, elision, bars, tones
// ---------------------------------------------------------------------------

/** Human-readable token count: "12.4k" / "1.2M", exact below 10k. */
export function formatHuman(value: number): string {
  if (!Number.isFinite(value)) return "n/a"
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 10_000) return `${(value / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`
  return formatTokens(value)
}

export function elideMiddle(value: string, max: number): string {
  if (max < 4) return value.slice(0, Math.max(0, max))
  if (value.length <= max) return value
  const keep = max - 1
  const head = Math.ceil(keep * 0.75)
  const tail = keep - head
  return `${value.slice(0, head)}…${tail > 0 ? value.slice(value.length - tail) : ""}`
}

export function elideEnd(value: string, max: number): string {
  if (value.length <= max) return value
  if (max <= 1) return value.slice(0, max)
  return `${value.slice(0, max - 1)}…`
}

export interface BarCells {
  readonly filled: number
  readonly empty: number
}

export function barCells(ratio: number | undefined, width: number): BarCells {
  const safe = typeof ratio === "number" && Number.isFinite(ratio) ? ratio : 0
  const clamped = Math.min(1, Math.max(0, safe))
  const cells = Math.max(0, Math.floor(width))
  const filled = Math.round(clamped * cells)
  return { filled, empty: Math.max(0, cells - filled) }
}

export type Tone = "base" | "muted" | "accent" | "success" | "warning" | "error" | "info"

/** Share-of-total color: small = calm, large = attention. */
export function toneForShare(share: number): Tone {
  if (share >= 0.85) return "error"
  if (share >= 0.6) return "warning"
  return "success"
}

/** Context-utilization color (percentage points). */
export function toneForUtilization(pct: number | undefined): Tone {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return "muted"
  if (pct >= 85) return "error"
  if (pct >= 60) return "warning"
  return "success"
}

/** Exact ratio with a zero-total guard; the only place shares are computed. */
function ratioOf(value: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(value)) return 0
  return value / total
}

// ---------------------------------------------------------------------------
// KPI row
// ---------------------------------------------------------------------------

export interface Kpi {
  readonly label: string
  readonly value: string
  readonly sub?: string
  readonly tone: Tone
  /** True when the value is a local heuristic estimate (badge shown). */
  readonly estimate?: boolean
}

export interface KpiGrid {
  readonly rows: readonly (readonly Kpi[])[]
  readonly cellWidth: number
}

/** Split KPIs into fitted rows for the layout; values are elided, never wrapped. */
export function kpiGrid(kpis: readonly Kpi[], layout: DashboardLayout): KpiGrid {
  const gap = 2
  const cellWidth = Math.max(12, Math.floor((layout.contentWidth - gap * (layout.kpiColumns - 1)) / layout.kpiColumns))
  // The rendered cell draws a left border plus one padding column.
  const textWidth = cellWidth - 2
  const fit = (kpi: Kpi): Kpi => ({
    label: elideEnd(kpi.label, textWidth),
    value: elideEnd(kpi.value, textWidth),
    sub: kpi.sub === undefined ? undefined : elideEnd(kpi.sub, textWidth),
    tone: kpi.tone,
    estimate: kpi.estimate,
  })
  const rows: (readonly Kpi[])[] = []
  for (let i = 0; i < kpis.length; i += layout.kpiColumns) {
    rows.push(kpis.slice(i, i + layout.kpiColumns).map(fit))
  }
  return { rows, cellWidth }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export interface HeaderModel {
  readonly title: string
  readonly badge: string
  readonly badgeTone: Tone
  readonly meta: readonly string[]
}

function fitMeta(meta: readonly string[], layout: DashboardLayout): readonly string[] {
  const out: string[] = []
  let used = 0
  for (const item of meta) {
    const prefix = out.length === 0 ? "" : " · "
    if (used + prefix.length + item.length <= layout.contentWidth) {
      out.push(item)
      used += prefix.length + item.length
    } else {
      const remaining = layout.contentWidth - used - prefix.length
      if (remaining >= 4) out.push(elideEnd(item, remaining))
      break
    }
  }
  return out
}

export function sessionHeader(report: ReportPayload, layout: DashboardLayout): HeaderModel {
  const idWidth = layout.tier === "narrow" ? 14 : layout.tier === "medium" ? 22 : 30
  const meta = [
    elideMiddle(report.sessionID, idWidth),
    `${formatClock(report.capturedAt)}Z`,
    `agent ${report.agent}`,
    elideEnd(formatModel(report.model), layout.tier === "narrow" ? 18 : 34),
  ]
  return {
    title: "Context Doctor",
    badge: "≈ est",
    badgeTone: "info",
    meta: fitMeta(meta, layout),
  }
}

export function allSessionsHeader(stats: GlobalStatsPayload, layout: DashboardLayout): HeaderModel {
  const meta = [
    `${stats.totals.sessions} sessions · ${stats.totals.snapshots} snapshots`,
    `${stats.totals.locations} location${stats.totals.locations === 1 ? "" : "s"}`,
    `generated ${formatClock(stats.generatedAt)}Z`,
  ]
  return {
    title: "Context Doctor · all sessions",
    badge: "captured only",
    badgeTone: "info",
    meta: fitMeta(meta, layout),
  }
}

// ---------------------------------------------------------------------------
// Composition bars and insights (session overview)
// ---------------------------------------------------------------------------

export interface AlignedBarRow {
  readonly label: string
  readonly bar: BarCells
  readonly value: string
  readonly percent: string
  readonly note: string
  readonly tone: Tone
}

export interface CompositionBlock {
  readonly totalTokens: number
  readonly totalText: string
  readonly rows: readonly AlignedBarRow[]
}

/**
 * System / messages / tool-schema split of the estimated input total.
 * Denominator is always `totals.estimatedInputTokens` (this snapshot).
 */
export function compositionBlock(report: ReportPayload, layout: DashboardLayout): CompositionBlock {
  const total = report.totals.estimatedInputTokens
  const narrowLabels = layout.tier === "narrow"
  const entries = [
    { label: narrowLabels ? "sys" : "system", tokens: report.totals.systemTokens, note: `${report.system.parts} parts` },
    { label: narrowLabels ? "msgs" : "messages", tokens: report.totals.messageTokens, note: `${report.messages.total} msgs` },
    { label: narrowLabels ? "tools" : "tool schemas", tokens: report.totals.toolTokens, note: `${report.tools.total} tools` },
  ]
  const labelWidth = Math.max(...entries.map(entry => entry.label.length))
  const valueWidth = Math.max(6, ...entries.map(entry => formatHuman(entry.tokens).length))
  const rows: AlignedBarRow[] = entries.map(({ label, tokens, note }) => {
    const share = ratioOf(tokens, total)
    return {
      label: label.padEnd(labelWidth),
      bar: barCells(share, layout.barWidth),
      value: formatHuman(tokens).padStart(valueWidth),
      percent: formatPercent(share).padStart(6),
      note: layout.tier === "narrow" ? "" : elideEnd(note, 18),
      tone: "accent",
    }
  })
  return { totalTokens: total, totalText: formatTokens(total), rows }
}

export interface Insight {
  readonly text: string
  readonly tone: Tone
}

/** Dominant consumer of the estimated input, denominator = snapshot total. */
export function dominantConsumerInsight(report: ReportPayload): Insight | undefined {
  const total = report.totals.estimatedInputTokens
  if (total <= 0) return undefined
  const parts = [
    { label: "system prompt", tokens: report.totals.systemTokens },
    { label: "messages", tokens: report.totals.messageTokens },
    { label: "tool schemas", tokens: report.totals.toolTokens },
  ].filter(part => part.tokens > 0)
  if (parts.length === 0) return undefined
  const top = parts.reduce((a, b) => (b.tokens > a.tokens ? b : a))
  const share = ratioOf(top.tokens, total)
  return {
    text: `${top.label} dominate · ${formatPercent(share)} of est. input (${formatTokens(top.tokens)} of ${formatTokens(total)} tok)`,
    tone: "accent",
  }
}

/** Top tool-schema consumer; denominator = the tool-schema subtotal. */
export function topSchemaToolInsight(report: ReportPayload): Insight | undefined {
  if (report.tools.ranked.length === 0 || report.tools.estimatedTokens <= 0) return undefined
  const top = report.tools.ranked[0]!
  const share = ratioOf(top.estimatedTokens, report.tools.estimatedTokens)
  return {
    text: `${top.id} is the largest schema · ${formatTokens(top.estimatedTokens)} of ${formatTokens(report.tools.estimatedTokens)} tok (${formatPercent(share)})`,
    tone: "accent",
  }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface TableColumnSpec {
  readonly title: string
  readonly align: "left" | "right"
  /** Minimum width kept even when shrinking (defaults to title length). */
  readonly min?: number
  /** Allow this column to shrink/elide to fit (default true). */
  readonly shrinkable?: boolean
  readonly elide?: "end" | "middle"
}

export interface TableCellInput {
  readonly text: string
  readonly tone?: Tone
  readonly bold?: boolean
}

export interface TableCellModel {
  readonly padded: string
  readonly tone: Tone
  readonly bold: boolean
}

export interface TableRowModel {
  readonly cells: readonly TableCellModel[]
}

export interface TableModel {
  readonly header: readonly string[]
  readonly rows: readonly TableRowModel[]
  readonly width: number
  readonly columnWidths: readonly number[]
}

const TABLE_GAP = 2

/**
 * Deterministic aligned table: widths come from content, then shrinkable
 * columns absorb overflow (eliding their cells) until the whole row fits
 * `layout.contentWidth`. The result can never exceed the content width.
 */
export function buildTable(
  specs: readonly TableColumnSpec[],
  rows: readonly (readonly TableCellInput[])[],
  layout: DashboardLayout,
): TableModel {
  const count = specs.length
  const available = layout.contentWidth - TABLE_GAP * (count - 1)
  const natural = specs.map((spec, i) =>
    Math.max(
      spec.title.length,
      spec.min ?? 0,
      ...rows.map(row => (row[i]?.text ?? "").length),
    ),
  )

  let widths = [...natural]
  if (widths.reduce((sum, w) => sum + w, 0) > available) {
    const floors = specs.map((spec, i) => Math.min(widths[i]!, Math.max(spec.title.length, spec.min ?? 2)))
    const shrinkable = specs.map((spec, i) => (spec.shrinkable !== false ? widths[i]! : floors[i]!))
    const shrinkableTotal = shrinkable.reduce((sum, w) => sum + w, 0)
    const fixed = specs.map((spec, i) => (spec.shrinkable === false ? widths[i]! : 0)).reduce((sum, w) => sum + w, 0)
    const budget = Math.max(fixed + specs.length, available)
    widths = specs.map((spec, i) => {
      if (spec.shrinkable === false) return widths[i]!
      const share = shrinkableTotal > 0 ? shrinkable[i]! / shrinkableTotal : 1 / count
      return Math.max(floors[i]!, Math.floor((budget - fixed) * share))
    })
    // Distribute any remainder to the widest shrinkable columns.
    let remainder = available - widths.reduce((sum, w) => sum + w, 0)
    const order = specs
      .map((_, i) => i)
      .filter(i => specs[i]!.shrinkable !== false)
      .sort((a, b) => widths[b]! - widths[a]!)
    for (const i of order) {
      if (remainder <= 0) break
      widths[i]! += 1
      remainder -= 1
    }
    // Hard guarantee: if floors alone overflow, clamp right-to-left.
    let index = count - 1
    while (widths.reduce((sum, w) => sum + w, 0) > available && index >= 0) {
      if (specs[index]!.shrinkable !== false && widths[index]! > 1) widths[index]! -= 1
      index -= 1
    }
    // Last resort at extreme widths: shrink every column (including fixed
    // numeric ones), never below 2 cells, so the fit invariant always holds.
    let overflow = widths.reduce((sum, w) => sum + w, 0) - available
    if (overflow > 0) {
      const total = widths.reduce((sum, w) => sum + w, 0)
      widths = widths.map(width => Math.max(2, width - Math.ceil((overflow * width) / total)))
      let guard = 0
      let last = count - 1
      while (widths.reduce((sum, w) => sum + w, 0) > available && guard < available) {
        if (widths[last]! > 2) widths[last]! -= 1
        last = last <= 0 ? count - 1 : last - 1
        guard += 1
      }
    }
  }

  const fitCell = (text: string, i: number): string => {
    const width = widths[i]!
    if (text.length <= width) return text
    return specs[i]!.elide === "middle" ? elideMiddle(text, width) : elideEnd(text, width)
  }
  const pad = (text: string, i: number): string =>
    specs[i]!.align === "right" ? text.padStart(widths[i]!) : text.padEnd(widths[i]!)

  return {
    header: specs.map((spec, i) => pad(fitCell(spec.title, i), i)),
    columnWidths: widths,
    width: widths.reduce((sum, w) => sum + w, 0) + TABLE_GAP * (count - 1),
    rows: rows.map(row => ({
      cells: row.map((cell, i) => ({
        padded: pad(fitCell(cell.text, i), i),
        tone: cell.tone ?? "base",
        bold: cell.bold ?? false,
      })),
    })),
  }
}

function rowsOf(table: TableModel): string[] {
  return table.rows.map(row => row.cells.map(cell => cell.padded).join("  ".repeat(TABLE_GAP / 2)).trimEnd())
}

/** Joined plain rows (used by tests and the preview harness). */
export function tableLines(table: TableModel): readonly string[] {
  return [table.header.join("  ").trimEnd(), ...rowsOf(table)]
}

// --- session tables ---------------------------------------------------------

export function categoriesTable(report: ReportPayload, layout: DashboardLayout): TableModel {
  const total = report.messages.categories.reduce((sum, entry) => sum + entry.estimatedTokens, 0)
  const specs: TableColumnSpec[] = [
    { title: "category", align: "left", min: 8 },
    { title: "parts", align: "right", shrinkable: false },
    { title: "tok (est)", align: "right", shrinkable: false },
    ...(layout.tier === "narrow" ? [] : [{ title: "% msgs", align: "right" as const, shrinkable: false }]),
  ]
  const rows = report.messages.categories
    .filter(entry => entry.parts > 0 || entry.estimatedTokens > 0)
    .map(entry => {
      const share = ratioOf(entry.estimatedTokens, total)
      const cells: TableCellInput[] = [
        { text: entry.category, tone: "base" },
        { text: String(entry.parts), tone: "muted" },
        { text: formatTokens(entry.estimatedTokens), tone: "base" },
      ]
      if (layout.tier !== "narrow") cells.push({ text: formatPercent(share), tone: toneForShare(share) })
      return cells
    })
  return buildTable(specs, rows, layout)
}

export function toolSchemaTable(report: ReportPayload, layout: DashboardLayout): TableModel {
  const total = report.tools.estimatedTokens
  const specs: TableColumnSpec[] = [
    { title: "#", align: "right", shrinkable: false },
    { title: "tool", align: "left", min: 8, elide: "middle" },
    { title: "tok (est)", align: "right", shrinkable: false },
    ...(layout.tier === "narrow"
      ? []
      : [
          { title: "% tools", align: "right" as const, shrinkable: false },
          ...(layout.tier === "wide"
            ? [
                { title: "props", align: "right" as const, shrinkable: false },
                { title: "group", align: "left" as const, min: 5, elide: "end" as const },
              ]
            : []),
        ]),
  ]
  const rows = report.tools.ranked.map((tool, index) => {
    const share = ratioOf(tool.estimatedTokens, total)
    const group = tool.group.kind === "mcp-server" ? `mcp:${tool.group.name}?` : "other"
    const cells: TableCellInput[] = [
      { text: String(index + 1), tone: "muted" },
      { text: tool.id, tone: index === 0 ? "accent" : "base", bold: index === 0 },
      { text: formatTokens(tool.estimatedTokens), tone: "base" },
    ]
    if (layout.tier !== "narrow") {
      cells.push({ text: formatPercent(share), tone: toneForShare(share) })
      if (layout.tier === "wide") {
        cells.push({ text: String(tool.schemaProperties), tone: "muted" })
        cells.push({ text: group, tone: "muted" })
      }
    }
    return cells
  })
  return buildTable(specs, rows, layout)
}

export function toolGroupsBlock(report: ReportPayload, layout: DashboardLayout): readonly AlignedBarRow[] {
  if (report.tools.groups.length <= 1) return []
  const labelWidth = Math.max(...report.tools.groups.map(group => group.name.length))
  const valueWidth = Math.max(6, ...report.tools.groups.map(group => formatHuman(group.estimatedTokens).length))
  return report.tools.groups.map(group => ({
    label: elideEnd(group.name, Math.max(labelWidth, 8)).padEnd(Math.max(labelWidth, 8)),
    bar: barCells(group.share, layout.barWidth),
    value: formatHuman(group.estimatedTokens).padStart(valueWidth),
    percent: formatPercent(group.share).padStart(6),
    note: layout.tier === "narrow" ? "" : `${group.tools} tools`,
    tone: "accent",
  }))
}

export function toolIOTable(report: ReportPayload, layout: DashboardLayout): TableModel {
  const io = report.tools.io
  const specs: TableColumnSpec[] = [
    { title: "tool", align: "left", min: 8, elide: "middle" },
    ...(layout.tier === "narrow"
      ? []
      : [
          { title: "calls", align: "right" as const, shrinkable: false },
          { title: "results", align: "right" as const, shrinkable: false },
        ]),
    { title: "tok (est)", align: "right", shrinkable: false },
  ]
  const rows = io.ranked.map((entry, index) => {
    const cells: TableCellInput[] = [{ text: entry.name, tone: index === 0 ? "accent" : "base" }]
    if (layout.tier !== "narrow") {
      cells.push({ text: `${entry.calls}x`, tone: "muted" })
      cells.push({ text: `${entry.results}x`, tone: "muted" })
    }
    cells.push({ text: formatTokens(entry.estimatedTokens), tone: "base" })
    return cells
  })
  return buildTable(specs, rows, layout)
}

export function rolesTable(report: ReportPayload, layout: DashboardLayout): TableModel {
  const specs: TableColumnSpec[] = [
    { title: "role", align: "left" },
    { title: "msgs", align: "right", shrinkable: false },
    { title: "parts", align: "right", shrinkable: false },
    { title: "tok (est)", align: "right", shrinkable: false },
    ...(layout.tier === "wide" ? [{ title: "chars", align: "right" as const, shrinkable: false }] : []),
  ]
  const rows = report.messages.byRole.map(role => {
    const cells: TableCellInput[] = [
      { text: role.role, tone: "base" },
      { text: String(role.messages), tone: "muted" },
      { text: String(role.parts), tone: "muted" },
      { text: formatTokens(role.estimatedTokens), tone: "base" },
    ]
    if (layout.tier === "wide") cells.push({ text: formatTokens(role.characters), tone: "muted" })
    return cells
  })
  return buildTable(specs, rows, layout)
}

export function partTypesTable(report: ReportPayload, layout: DashboardLayout): TableModel {
  const specs: TableColumnSpec[] = [
    { title: "part type", align: "left" },
    { title: "parts", align: "right", shrinkable: false },
    { title: "tok (est)", align: "right", shrinkable: false },
  ]
  const rows = report.messages.byPartType.map(part => [
    { text: part.countedOnly ? `${part.partType} *` : part.partType, tone: "base" },
    { text: String(part.parts), tone: "muted" },
    { text: part.countedOnly && part.estimatedTokens === 0 ? "—" : formatTokens(part.estimatedTokens), tone: "muted" },
  ] as readonly TableCellInput[])
  return buildTable(specs, rows, layout)
}

export function largestMessagesTable(report: ReportPayload, layout: DashboardLayout): TableModel {
  if (report.messages.largest.length === 0) return buildTable([{ title: "no messages", align: "left" }], [], layout)
  const specs: TableColumnSpec[] = [
    { title: "#", align: "right", shrinkable: false },
    { title: "role", align: "left" },
    { title: "parts", align: "right", shrinkable: false },
    { title: "tok (est)", align: "right", shrinkable: false },
    ...(layout.tier === "wide" ? [{ title: "chars", align: "right" as const, shrinkable: false }] : []),
  ]
  const rows = report.messages.largest.map(message => {
    const cells: TableCellInput[] = [
      { text: String(message.index), tone: "muted" },
      { text: message.role, tone: "base" },
      { text: String(message.parts), tone: "muted" },
      { text: formatTokens(message.estimatedTokens), tone: "base" },
    ]
    if (layout.tier === "wide") cells.push({ text: formatTokens(message.characters), tone: "muted" })
    return cells
  })
  return buildTable(specs, rows, layout)
}

export interface HistoryModel {
  readonly points: number
  readonly totalPoints: number
  readonly table: TableModel
  readonly note: string
}

export function historyModel(report: ReportPayload, layout: DashboardLayout, lastN: number | undefined): HistoryModel {
  const all = report.history
  const points = lastN !== undefined ? all.slice(-lastN) : all
  const totalPoints = all.length
  const specs: TableColumnSpec[] = [
    { title: "time", align: "left", shrinkable: false },
    { title: "est total", align: "right", shrinkable: false },
    ...(layout.tier === "medium" || layout.tier === "wide"
      ? [{ title: "delta", align: "right" as const, shrinkable: false }]
      : []),
    { title: "msgs", align: "right", shrinkable: false },
    ...(layout.tier !== "narrow"
      ? [
          { title: "sys", align: "right" as const, shrinkable: false },
          { title: "msg", align: "right" as const, shrinkable: false },
          { title: "tools", align: "right" as const, shrinkable: false },
        ]
      : []),
  ]
  const rows = points.map((point, index) => {
    const previous = index > 0 ? points[index - 1] : undefined
    const delta = previous === undefined ? undefined : point.estimatedInputTokens - previous.estimatedInputTokens
    const deltaText =
      delta === undefined ? "—" : `${delta >= 0 ? "+" : ""}${formatHuman(delta)}`
    const cells: TableCellInput[] = [
      { text: `${formatClock(point.capturedAt)}Z`, tone: "muted" },
      { text: formatTokens(point.estimatedInputTokens), tone: "base" },
    ]
    if (layout.tier !== "narrow") cells.push({ text: deltaText, tone: delta !== undefined && delta > 0 ? "warning" : "muted" })
    cells.push({ text: String(point.messageCount), tone: "muted" })
    if (layout.tier !== "narrow") {
      cells.push({ text: formatHuman(point.systemTokens), tone: "muted" })
      cells.push({ text: formatHuman(point.messageTokens), tone: "muted" })
      cells.push({ text: formatHuman(point.toolTokens), tone: "muted" })
    }
    return cells
  })
  return {
    points: points.length,
    totalPoints,
    table: buildTable(specs, rows, layout),
    note:
      totalPoints <= 1
        ? "One snapshot so far — history grows as the session continues (a snapshot is taken each time the agent loop assembles context)."
        : `Newest last${lastN !== undefined ? ` · showing the last ${points.length} of ${totalPoints}` : ""}.`,
  }
}

// --- all-sessions tables ------------------------------------------------------

export function perModelTable(stats: GlobalStatsPayload, layout: DashboardLayout): TableModel {
  const narrow = layout.tier === "narrow"
  const specs: TableColumnSpec[] = [
    { title: "model", align: "left", min: 8, elide: "end" },
    { title: narrow ? "ses" : "sessions", align: "right", shrinkable: false },
    { title: narrow ? "avg" : "avg latest", align: "right", shrinkable: false },
    { title: "peak", align: "right", shrinkable: false },
  ]
  const rows = stats.context.perModel.map((model, index) => [
    { text: `${model.providerID}/${model.id}`, tone: index === 0 ? "accent" : "base" },
    { text: String(model.sessions), tone: "muted" },
    { text: formatHuman(model.avgLatestEstimatedInputTokens), tone: "base" },
    { text: formatHuman(model.peakEstimatedInputTokens), tone: "base" },
  ] as readonly TableCellInput[])
  return buildTable(specs, rows, layout)
}

export function allSessionsToolTables(stats: GlobalStatsPayload, layout: DashboardLayout): { schema: TableModel; io: TableModel } {
  const schemaSpecs: TableColumnSpec[] = [
    { title: "tool", align: "left", min: 8, elide: "middle" },
    { title: "sessions", align: "right", shrinkable: false },
    { title: "tok (est)", align: "right", shrinkable: false },
  ]
  const schema = buildTable(
    schemaSpecs,
    stats.tools?.schema.map((tool, index) => [
      { text: tool.id, tone: index === 0 ? "accent" : "base" },
      { text: String(tool.sessions), tone: "muted" },
      { text: formatTokens(tool.estimatedTokens), tone: "base" },
    ] as readonly TableCellInput[]) ?? [],
    layout,
  )
  const ioSpecs: TableColumnSpec[] = [
    { title: "tool", align: "left", min: 8, elide: "middle" },
    { title: "calls", align: "right", shrinkable: false },
    { title: "results", align: "right", shrinkable: false },
    { title: "tok (est)", align: "right", shrinkable: false },
  ]
  const io = buildTable(
    ioSpecs,
    stats.tools?.io.map((entry, index) => [
      { text: entry.name, tone: index === 0 ? "accent" : "base" },
      { text: String(entry.calls), tone: "muted" },
      { text: String(entry.results), tone: "muted" },
      { text: formatTokens(entry.estimatedTokens), tone: "base" },
    ] as readonly TableCellInput[]) ?? [],
    layout,
  )
  return { schema, io }
}

export function allSessionsSessionsTable(stats: GlobalStatsPayload, layout: DashboardLayout): TableModel {
  const specs: TableColumnSpec[] = [
    { title: "session", align: "left", min: 8, elide: "middle" },
    { title: "dir", align: "left", elide: "middle" },
    { title: "latest est", align: "right", shrinkable: false },
    ...(layout.tier === "narrow" ? [] : [{ title: "peak", align: "right" as const, shrinkable: false }]),
    { title: "snaps", align: "right", shrinkable: false },
  ]
  const rows = stats.sessions.map(session => {
    const directory = session.directory.split("/").filter(Boolean).pop() ?? session.directory
    const cells: TableCellInput[] = [
      { text: session.sessionID, tone: "base" },
      { text: directory || "?", tone: "muted" },
      { text: formatHuman(session.latestEstimatedInputTokens), tone: "base" },
    ]
    if (layout.tier !== "narrow") cells.push({ text: formatHuman(session.peakEstimatedInputTokens), tone: "muted" })
    cells.push({ text: String(session.snapshotCount), tone: "muted" })
    return cells
  })
  return buildTable(specs, rows, layout)
}

export function locationsTable(stats: GlobalStatsPayload, layout: DashboardLayout): TableModel {
  const specs: TableColumnSpec[] = [
    { title: "directory", align: "left", min: 8, elide: "middle" },
    { title: "sessions", align: "right", shrinkable: false },
    { title: "snapshots", align: "right", shrinkable: false },
    ...(layout.tier === "narrow" ? [] : [{ title: "last active", align: "left" as const, shrinkable: false }]),
  ]
  const rows = stats.locations.map(location => {
    const cells: TableCellInput[] = [
      { text: location.directory || "?", tone: "base" },
      { text: String(location.sessions), tone: "muted" },
      { text: String(location.snapshots), tone: "muted" },
    ]
    if (layout.tier !== "narrow") cells.push({ text: `${formatClock(location.lastActiveAt)}Z`, tone: "muted" })
    return cells
  })
  return buildTable(specs, rows, layout)
}

// ---------------------------------------------------------------------------
// KPI rows
// ---------------------------------------------------------------------------

export function sessionKpis(report: ReportPayload): readonly Kpi[] {
  const total = report.totals.estimatedInputTokens
  const window = report.reported.contextWindowTokens
  const pct = report.reported.utilizationEstimatedPct
  return [
    {
      label: "est. input ≈",
      value: formatHuman(total),
      sub: `${formatTokens(total)} tok`,
      tone: "accent",
      estimate: true,
    },
    window !== undefined
      ? {
          label: "context",
          value: pct !== undefined ? `${pct.toFixed(1)}%` : "n/a",
          sub: `${formatHuman(window)} window`,
          tone: toneForUtilization(pct),
          estimate: true,
        }
      : { label: "context", value: "n/a", sub: "window unknown", tone: "muted" },
    { label: "messages", value: String(report.messages.total), sub: `${report.tools.total} tools`, tone: "base" },
    { label: "model", value: `${report.model.providerID}/${report.model.id}`, sub: `agent ${report.agent}`, tone: "base" },
  ]
}

export function allSessionsKpis(stats: GlobalStatsPayload): readonly Kpi[] {
  return [
    { label: "sessions", value: formatTokens(stats.totals.sessions), sub: `${formatTokens(stats.totals.snapshots)} snapshots`, tone: "base" },
    {
      label: "avg latest ≈",
      value: formatHuman(stats.context.avgLatestEstimatedInputTokens),
      sub: "est per session",
      tone: "accent",
      estimate: true,
    },
    {
      label: "peak ≈",
      value: formatHuman(stats.context.peakEstimatedInputTokens),
      sub: "est per session",
      tone: "accent",
      estimate: true,
    },
    { label: "locations", value: String(stats.totals.locations), sub: `cap ${stats.retention.maxSessionsPerLocation}/loc`, tone: "base" },
  ]
}

// ---------------------------------------------------------------------------
// Usage tab
// ---------------------------------------------------------------------------

export interface UsageBar {
  readonly label: string
  readonly bar: BarCells
  readonly value: string
  readonly percent: string | undefined
  readonly tone: Tone
}

export interface UsageModel {
  readonly available: boolean
  readonly kpis: readonly Kpi[]
  readonly kv: readonly { readonly key: string; readonly value: string; readonly tone?: Tone }[]
  readonly auxiliary: readonly { readonly key: string; readonly value: string }[]
  readonly utilization: UsageBar | undefined
  readonly notes: readonly string[]
}

function reportedKpis(tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }): readonly Kpi[] {
  return [
    { label: "input", value: formatHuman(tokens.input), sub: `${formatTokens(tokens.input)} tok`, tone: "base" },
    { label: "output", value: formatHuman(tokens.output), sub: `${formatTokens(tokens.output)} tok`, tone: "base" },
    { label: "cache read", value: formatHuman(tokens.cacheRead), sub: `${formatTokens(tokens.cacheRead)} tok`, tone: "base" },
    { label: "cache write", value: formatHuman(tokens.cacheWrite), sub: `${formatTokens(tokens.cacheWrite)} tok`, tone: "base" },
  ]
}

export function sessionUsageModel(report: ReportPayload, layout: DashboardLayout): UsageModel {
  const reported = report.reported
  const cumulative = reported.cumulative
  const window = reported.contextWindowTokens
  const pct = reported.utilizationEstimatedPct
  const utilization: UsageBar | undefined =
    window !== undefined
      ? {
          label: "estimated context",
          bar: barCells(pct !== undefined ? pct / 100 : 0, layout.barWidth),
          value: `${formatHuman(report.totals.estimatedInputTokens)} of ${formatHuman(window)} tok`,
          percent: pct !== undefined ? `${pct.toFixed(1)}%` : undefined,
          tone: toneForUtilization(pct),
        }
      : undefined
  return {
    available: cumulative !== undefined,
    kpis: cumulative ? reportedKpis(cumulative.tokens) : [],
    kv: cumulative
      ? [
          { key: "source", value: cumulative.source, tone: "muted" },
          { key: "captured", value: `${formatClock(cumulative.capturedAt)}Z`, tone: "muted" },
          { key: "kind", value: cumulative.ephemeral ? "ephemeral (live event)" : "durable (per-step sum)", tone: "muted" },
          ...(reported.lastStep
            ? [{ key: "last reply", value: `in ${formatTokens(reported.lastStep.tokens.input)} · out ${formatTokens(reported.lastStep.tokens.output)}`, tone: "muted" as const }]
            : []),
          ...(reported.durableSteps !== undefined
            ? [{ key: "durable steps", value: String(reported.durableSteps), tone: "muted" as const }]
            : []),
        ]
      : [{ key: "status", value: "no provider-reported usage observed yet", tone: "muted" }],
    auxiliary: (reported.auxiliary ?? []).map(aux => ({
      key: aux.source,
      value: `in ${formatTokens(aux.tokens.input)} · out ${formatTokens(aux.tokens.output)} (never summed)`,
    })),
    utilization,
    notes: reported.notes,
  }
}

export function allSessionsUsageModel(stats: GlobalStatsPayload): UsageModel {
  const usage = stats.usage
  if (usage === undefined) {
    return { available: false, kpis: [], kv: [], auxiliary: [], utilization: undefined, notes: stats.notes }
  }
  return {
    available: true,
    kpis: reportedKpis(usage.tokens),
    kv: [
      { key: "sessions with usage", value: String(usage.sessionsWithUsage), tone: "muted" },
      ...(usage.capturedThrough !== undefined
        ? [{ key: "captured through", value: `${formatClock(usage.capturedThrough)}Z`, tone: "muted" as const }]
        : []),
      { key: "rule", value: "sum of each session's LATEST cumulative value — never repeated events", tone: "muted" },
    ],
    auxiliary: [],
    utilization: undefined,
    notes: stats.notes,
  }
}

// ---------------------------------------------------------------------------
// Details tab
// ---------------------------------------------------------------------------

export interface ProseBlock {
  readonly title: string
  readonly lines: readonly string[]
}

/** Wrap every block line to the content width: the fit invariant must hold even without renderer wrapping. */
function wrappedBlock(title: string, lines: readonly string[], layout: DashboardLayout): ProseBlock {
  return { title, lines: lines.flatMap(line => wrapProse(line, layout.contentWidth)) }
}

export function sessionDetails(report: ReportPayload, layout: DashboardLayout): readonly ProseBlock[] {
  const width = layout.contentWidth
  const blocks: ProseBlock[] = [
    {
      title: "Session",
      lines: [
        `id ${elideMiddle(report.sessionID, width - 4)}`,
        `agent ${report.agent} · model ${formatModel(report.model)}`,
        `captured ${new Date(report.capturedAt).toISOString().slice(0, 19).replace("T", " ")}Z`,
      ],
    },
    {
      title: "Estimation (heuristic, local)",
      lines: [
        `~${report.estimation.latinCharsPerToken} chars/tok latin · ~${report.estimation.cjkCharsPerToken} chars/tok CJK · remote calls: ${report.estimation.remoteCalls ? "yes" : "none"}`,
        report.estimation.note,
      ],
    },
    {
      title: "System prompt",
      lines: [
        `${report.system.parts} parts · ${formatTokens(report.system.characters)} chars · ${report.system.cacheHintedParts} cache-hinted · estimated ${formatTokens(report.system.estimatedTokens)} tok`,
        report.system.provenance.note,
      ],
    },
    {
      title: "Messages by role",
      lines: tableLines(rolesTable(report, layout)),
    },
    {
      title: "Messages by part type (* counted only, not token-estimated)",
      lines: tableLines(partTypesTable(report, layout)),
    },
    {
      title: "Largest messages",
      lines: tableLines(largestMessagesTable(report, layout)),
    },
    {
      title: "Retention & errors",
      lines: [
        `sessions tracked ${report.retention.sessionsTracked}/${report.retention.maxSessions} · snapshots ${report.retention.snapshotsForSession}/${report.retention.maxSnapshotsPerSession} (this session) · hook errors ${report.errors.hookErrorCount}`,
        ...(report.errors.lastErrorAt !== undefined
          ? [
              `last hook error ${new Date(report.errors.lastErrorAt).toISOString().slice(0, 19).replace("T", " ")}Z${report.errors.lastErrorCode ? ` · ${report.errors.lastErrorCode}` : ""}`,
            ]
          : []),
      ],
    },
    { title: "Scope", lines: [report.scope.note] },
    { title: "Limits & attribution notes", lines: report.limits.map(limit => `· ${limit}`) },
  ]
  return blocks.map(block => wrappedBlock(block.title, block.lines, layout))
}

export function allSessionsDetails(stats: GlobalStatsPayload, layout: DashboardLayout): readonly ProseBlock[] {
  const blocks: ProseBlock[] = [
    { title: "Locations", lines: tableLines(locationsTable(stats, layout)) },
    {
      title: "Retention",
      lines: [
        `sessions ${stats.retention.sessions} · snapshots ${stats.retention.snapshots} · cap ${stats.retention.maxSessionsPerLocation} sessions/location · max age ${Math.round(stats.retention.maxAgeMs / 3_600_000)}h`,
      ],
    },
    {
      title: "Coverage & limits",
      lines: stats.notes.map(note => `· ${note}`),
    },
  ]
  return blocks.map(block => wrappedBlock(block.title, block.lines, layout))
}

// ---------------------------------------------------------------------------
// Prose wrapping (fallback for renderers without wrap support)
// ---------------------------------------------------------------------------

/** Greedy word wrap; only used for preflight/preview, the TUI wraps natively. */
export function wrapProse(text: string, width: number): readonly string[] {
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    let line = ""
    for (const word of paragraph.split(/\s+/)) {
      if (word === "") continue
      const candidate = line === "" ? word : `${line} ${word}`
      if (candidate.length <= width) {
        line = candidate
      } else {
        if (line !== "") lines.push(line)
        line = word.length > width ? elideMiddle(word, width) : word
      }
    }
    if (line !== "") lines.push(line)
  }
  return lines
}
