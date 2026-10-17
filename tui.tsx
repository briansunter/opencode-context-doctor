/**
 * OpenCode V2 TUI plugin: the /context-doctor command.
 *
 * Renders a compact, responsive dashboard in a custom-JSX dialog: a KPI row,
 * colored composition bars, aligned ranked tables, and tabs (Overview / Tools /
 * History / Usage / Details; the `all` view swaps in Sessions). All layout,
 * math, and elision live in the pure view model (dashboard.ts); this file maps
 * semantic tones onto the host's theme tokens and owns keyboard navigation.
 *
 * No LLM calls, no prompts, no transcript injection: the only server
 * interaction is the typed RPC in rpc.ts.
 *
 * RPC location scoping: the server plugin instance is bound to its own
 * location, so every RPC call passes an explicit `location`. For a session
 * report that location is the *session's* location (from session info),
 * because `context.location` / the default location can differ from where a
 * session actually lives (for example after it moved).
 */
import { TextAttributes, rgbToHex, RGBA, type ScrollBoxRenderable } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For } from "solid-js"
import { parseReportArgs, type FormatOptions } from "./format.ts"
import {
  ALL_SESSIONS_TABS,
  allSessionsDetails,
  allSessionsHeader,
  allSessionsKpis,
  allSessionsSessionsTable,
  allSessionsToolTables,
  allSessionsUsageModel,
  categoriesTable,
  compositionBlock,
  dominantConsumerInsight,
  footerHint,
  historyModel,
  kpiGrid,
  layoutFor,
  perModelTable,
  sessionDetails,
  sessionHeader,
  sessionKpis,
  sessionUsageModel,
  sessionDialogPlan,
  tabBarRows,
  toolGroupsBlock,
  toolIOTable,
  toolSchemaTable,
  topSchemaToolInsight,
  type AlignedBarRow,
  type DashboardLayout,
  type DashboardTab,
  type KpiGrid,
  type TableModel,
  type Tone,
} from "./dashboard.ts"
import { ContextDoctor } from "./rpc.ts"
import type { GlobalStatsPayload, ListPayload, ReportPayload } from "./types.ts"

// ---------------------------------------------------------------------------
// Pure flow (testable without a renderer)
// ---------------------------------------------------------------------------

export interface ContextDoctorRpcLike {
  list(): Promise<ListPayload>
  report(sessionID: string): Promise<ReportPayload>
  /** Cross-location aggregate (any location's instance can answer; the database is shared per user). */
  stats(): Promise<GlobalStatsPayload>
}

export interface ReportDialogSurface {
  select<T>(options: {
    title: string
    options: readonly { title: string; value: T; description?: string; category?: string }[]
  }): Promise<T | undefined>
  show(render: () => JSX.Element, onClose?: () => void): void
  set(options: { size?: "medium" | "large" | "xlarge"; centered?: boolean }): void
  alert(options: { title: string; message: string }): Promise<void>
}

export interface ReportFlowDeps {
  readonly rpc: ContextDoctorRpcLike
  readonly currentSessionID: () => string | undefined
  readonly dialog: ReportDialogSurface
  readonly renderReport: (report: ReportPayload, options: FormatOptions) => void
  readonly renderStats: (stats: GlobalStatsPayload) => void
  readonly toast: (options: { message: string; variant?: "info" | "success" | "warning" | "error" }) => void
}

export async function runContextDoctor(deps: ReportFlowDeps, args?: string): Promise<void> {
  const options = parseReportArgs(args)
  if (options.stats) {
    let stats: GlobalStatsPayload
    try {
      stats = await deps.rpc.stats()
    } catch (error) {
      deps.toast({ message: `Context Doctor: could not load all-sessions stats - ${errorMessage(error)}`, variant: "error" })
      return
    }
    deps.renderStats(stats)
    return
  }

  let sessionID = deps.currentSessionID()
  if (!sessionID) {
    let list: ListPayload
    try {
      list = await deps.rpc.list()
    } catch (error) {
      deps.toast({ message: `Context Doctor: could not list sessions - ${errorMessage(error)}`, variant: "error" })
      return
    }
    if (list.sessions.length === 0) {
      await deps.dialog.alert({
        title: "Context Doctor",
        message: "No tracked sessions at this location yet. Send a prompt first: snapshots are recorded when the agent loop assembles context.",
      })
      return
    }
    sessionID = await deps.dialog.select({
      title: "Context Doctor: choose a session",
      options: list.sessions.slice(0, 30).map(summary => ({
        title: summary.sessionID,
        description: `${summary.agent} · ${summary.lastMessageCount} msgs · ${summary.snapshotCount} snapshots`,
        value: summary.sessionID,
      })),
    })
    if (!sessionID) return
  }

  let report: ReportPayload
  try {
    report = await deps.rpc.report(sessionID)
  } catch (error) {
    const type = (error as { type?: string } | null)?.type
    const message = errorMessage(error)
    if (type === "unknown_session") {
      await deps.dialog.alert({
        title: "Context Doctor",
        message: `No context snapshot for this session yet. ${message}`,
      })
      return
    }
    deps.toast({ message: `Context Doctor: ${message}`, variant: "error" })
    return
  }
  deps.renderReport(report, parseReportArgs(args))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// Keyboard navigation (pure command factory)
// ---------------------------------------------------------------------------

export interface DashboardNavigation {
  readonly tabs: readonly { readonly id: string; readonly title?: string }[]
  readonly current: () => string
  readonly select: (id: string) => void
  /** Viewport-relative page size in rows (defaults to 20). */
  readonly pageSize?: () => number
}

export type DashboardCommands = readonly {
  readonly id: string
  readonly title: string
  readonly group: string
  readonly bind: string
  readonly run: () => void
}[]

const JUMP = 1_000_000

/**
 * Modal-layer commands for the dashboard dialog. The layer is created by the
 * dialog component itself (see DashboardShell), so these bindings exist only
 * while the dialog is mounted and never steal host keys otherwise.
 */
export function dashboardCommands(nav: DashboardNavigation, scrollBy: (delta: number) => void): DashboardCommands {
  const page = () => Math.max(3, nav.pageSize?.() ?? 20)
  const step = (delta: number) => {
    const index = nav.tabs.findIndex(tab => tab.id === nav.current())
    if (index === -1 || nav.tabs.length === 0) return
    const next = (index + delta + nav.tabs.length) % nav.tabs.length
    nav.select(nav.tabs[next]!.id)
  }
  return [
    { id: "context-doctor.scroll.up", title: "Scroll up", group: "Context Doctor", bind: "up", run: () => scrollBy(-1) },
    { id: "context-doctor.scroll.down", title: "Scroll down", group: "Context Doctor", bind: "down", run: () => scrollBy(1) },
    { id: "context-doctor.scroll.page-up", title: "Page up", group: "Context Doctor", bind: "pageup", run: () => scrollBy(-page()) },
    { id: "context-doctor.scroll.page-down", title: "Page down", group: "Context Doctor", bind: "pagedown", run: () => scrollBy(page()) },
    { id: "context-doctor.scroll.top", title: "Jump to top", group: "Context Doctor", bind: "home", run: () => scrollBy(-JUMP) },
    { id: "context-doctor.scroll.bottom", title: "Jump to bottom", group: "Context Doctor", bind: "end", run: () => scrollBy(JUMP) },
    { id: "context-doctor.scroll.top-vim", title: "Jump to top (vim)", group: "Context Doctor", bind: "g", run: () => scrollBy(-JUMP) },
    { id: "context-doctor.scroll.bottom-vim", title: "Jump to bottom (vim)", group: "Context Doctor", bind: "G", run: () => scrollBy(JUMP) },
    { id: "context-doctor.tab.next", title: "Next tab", group: "Context Doctor", bind: "right", run: () => step(1) },
    { id: "context-doctor.tab.prev", title: "Previous tab", group: "Context Doctor", bind: "left", run: () => step(-1) },
    ...nav.tabs.map((tab, index) => ({
      id: `context-doctor.tab.${tab.id}`,
      title: `Open ${tab.title ?? tab.id} tab`,
      group: "Context Doctor",
      bind: String(index + 1),
      run: () => nav.select(tab.id),
    })),
  ]
}

// ---------------------------------------------------------------------------
// Theme palette
// ---------------------------------------------------------------------------

export interface DashboardPalette {
  readonly base: string
  readonly muted: string
  readonly heading: string
  readonly accent: string
  readonly success: string
  readonly warning: string
  readonly error: string
  readonly info: string
  readonly border: string
  readonly barEmpty: string
}

/**
 * Resolve display colors from the host's semantic theme tokens when available
 * (@opencode/theme is an optional peer, so token paths are probed defensively
 * and RGBA instances are converted to hex) with a static light/dark fallback
 * palette.
 */
export function paletteFrom(theme: unknown, themeMode: string | undefined): DashboardPalette {
  const root = theme as {
    text?: Record<string, unknown> & {
      action?: { primary?: { base?: unknown } }
      feedback?: Record<string, { base?: unknown }>
    }
    accent?: Record<string, unknown>
    hue?: Record<string, Record<string, unknown>>
    border?: { base?: unknown }
  } | null | undefined
  const light = themeMode === "light"

  const asColor = (value: unknown, fallback: string): string => {
    if (typeof value === "string" && value.length > 0) return value
    if (value instanceof RGBA) {
      try {
        return rgbToHex(value)
      } catch {
        return fallback
      }
    }
    return fallback
  }
  const pick = (group: Record<string, unknown> | undefined, keys: readonly string[], fallback: string): string => {
    for (const key of keys) {
      const value = group?.[key]
      if (typeof value === "string" && value.length > 0) return value
    }
    return fallback
  }

  const darkAccent = light ? "#0969da" : "#58a6ff"
  const accent = asColor(root?.text?.action?.primary?.base, pick(root?.accent, ["base", "fg", "primary"], asColor(root?.hue?.accent?.["500"], darkAccent)))
  const base = pick(root?.text, ["base", "primary", "default"], light ? "#1f2328" : "#e6edf3")
  const muted = pick(root?.text, ["muted", "subtle", "secondary", "base"], light ? "#59636e" : "#8b949e")
  const border = asColor(root?.border?.base, light ? "#d1d9e0" : "#3d444d")
  const feedback = (kind: string, fallback: string) => asColor(root?.text?.feedback?.[kind]?.base, fallback)

  return {
    base,
    muted,
    heading: accent,
    accent,
    success: feedback("success", light ? "#1a7f37" : "#3fb950"),
    warning: feedback("warning", light ? "#9a6700" : "#d29922"),
    error: feedback("error", light ? "#cf222e" : "#f85149"),
    info: feedback("info", light ? "#0969da" : "#58a6ff"),
    border,
    barEmpty: border,
  }
}

function toneColor(tone: Tone, colors: DashboardPalette): string {
  switch (tone) {
    case "muted":
      return colors.muted
    case "accent":
      return colors.accent
    case "success":
      return colors.success
    case "warning":
      return colors.warning
    case "error":
      return colors.error
    case "info":
      return colors.info
    default:
      return colors.base
  }
}

/**
 * `span` accepts fg/attributes at runtime (TextNodeOptions) but its JSX prop
 * type is narrowed to `{}`; build the attribute object with a local cast.
 */
function spanAttrs(fg: string | undefined, attributes: number | undefined): JSX.IntrinsicElements["span"] {
  return { fg, attributes } as unknown as JSX.IntrinsicElements["span"]
}

// ---------------------------------------------------------------------------
// Dialog view
// ---------------------------------------------------------------------------

function HeaderView(props: {
  readonly title: string
  readonly badge: string
  readonly badgeTone: Tone
  readonly meta: readonly string[]
  readonly colors: DashboardPalette
}): JSX.Element {
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={props.colors.heading} attributes={TextAttributes.BOLD}>{props.title}</text>
        <text fg={toneColor(props.badgeTone, props.colors)}>[{props.badge}]</text>
      </box>
      <text fg={props.colors.muted}>{props.meta.join(" · ")}</text>
    </box>
  )
}

function TabBar(props: {
  readonly tabs: readonly DashboardTab[]
  readonly active: () => string
  readonly colors: DashboardPalette
  readonly layout: DashboardLayout
}): JSX.Element {
  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <For each={tabBarRows(props.tabs, props.active(), props.layout)}>
        {row => (
          <box flexDirection="row" gap={2}>
            <For each={row}>
              {tab => (
                <text
                  fg={tab.active ? props.colors.accent : props.colors.muted}
                  attributes={tab.active ? TextAttributes.BOLD : undefined}
                >
                  {tab.active && tab.marker ? `▌${tab.text}` : tab.marker ? ` ${tab.text}` : tab.text}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

function KpiView(props: { readonly grid: KpiGrid; readonly colors: DashboardPalette }): JSX.Element {
  return (
    <For each={props.grid.rows}>
      {row => (
        <box flexDirection="row" gap={2} paddingBottom={1}>
          <For each={row}>
            {kpi => (
              <box
                flexDirection="column"
                width={props.grid.cellWidth}
                border={["left"]}
                borderColor={toneColor(kpi.tone, props.colors)}
                paddingLeft={1}
              >
                <text fg={props.colors.muted}>{kpi.label}</text>
                <text fg={toneColor(kpi.tone, props.colors)} attributes={TextAttributes.BOLD}>{kpi.value}</text>
                {kpi.sub === undefined ? null : <text fg={props.colors.muted}>{kpi.sub}</text>}
              </box>
            )}
          </For>
        </box>
      )}
    </For>
  )
}

function BarRows(props: { readonly rows: readonly AlignedBarRow[]; readonly colors: DashboardPalette }): JSX.Element {
  return (
    <For each={props.rows}>
      {row => (
        <text>
          <span {...spanAttrs(props.colors.muted, undefined)}>{`${row.label}  `}</span>
          <span {...spanAttrs(toneColor(row.tone, props.colors), undefined)}>{"█".repeat(row.bar.filled)}</span>
          <span {...spanAttrs(props.colors.barEmpty, undefined)}>{"░".repeat(row.bar.empty)}</span>
          <span {...spanAttrs(props.colors.base, undefined)}>{` ${row.value} `}</span>
          <span {...spanAttrs(toneColor(row.tone, props.colors), undefined)}>{row.percent}</span>
          {row.note === "" ? null : <span {...spanAttrs(props.colors.muted, undefined)}>{`  ${row.note}`}</span>}
        </text>
      )}
    </For>
  )
}

function TableView(props: { readonly model: TableModel; readonly colors: DashboardPalette }): JSX.Element {
  return (
    <box flexDirection="column">
      <text fg={props.colors.muted} attributes={TextAttributes.BOLD}>{props.model.header.join("  ").trimEnd()}</text>
      <For each={props.model.rows}>
        {row => (
          <text>
            <For each={row.cells}>
              {(cell, index) => (
                <span
                  {...spanAttrs(toneColor(cell.tone, props.colors), cell.bold ? TextAttributes.BOLD : undefined)}
                >
                  {index() === 0 ? cell.padded : `  ${cell.padded}`}
                </span>
              )}
            </For>
          </text>
        )}
      </For>
    </box>
  )
}

function SectionTitle(props: { readonly title: string; readonly colors: DashboardPalette }): JSX.Element {
  return <text fg={props.colors.heading} attributes={TextAttributes.BOLD} paddingTop={1}>{props.title}</text>
}

function InsightLine(props: { readonly text: string; readonly tone: Tone; readonly colors: DashboardPalette }): JSX.Element {
  return (
    <text fg={toneColor(props.tone, props.colors)}>
      {`▸ ${props.text}`}
    </text>
  )
}

function NoteLines(props: { readonly lines: readonly string[]; readonly colors: DashboardPalette }): JSX.Element {
  return (
    <For each={props.lines}>
      {line => (
        <text fg={props.colors.muted} wrapMode="word">{line}</text>
      )}
    </For>
  )
}

function KeyValueRows(props: {
  readonly rows: readonly { readonly key: string; readonly value: string; readonly tone?: Tone }[]
  readonly colors: DashboardPalette
}): JSX.Element {
  const keyWidth = props.rows.reduce((max, row) => Math.max(max, row.key.length), 0)
  return (
    <For each={props.rows}>
      {row => (
        <text>
          <span {...spanAttrs(props.colors.muted, undefined)}>{`${row.key.padEnd(keyWidth)}  `}</span>
          <span {...spanAttrs(toneColor(row.tone ?? "base", props.colors), undefined)}>{row.value}</span>
        </text>
      )}
    </For>
  )
}

function ProseBlocks(props: {
  readonly blocks: readonly { readonly title: string; readonly lines: readonly string[] }[]
  readonly colors: DashboardPalette
}): JSX.Element {
  return (
    <For each={props.blocks}>
      {block => (
        <box flexDirection="column" paddingBottom={1}>
          <SectionTitle title={block.title} colors={props.colors} />
          <For each={block.lines}>
            {line => (
              <text fg={props.colors.base} wrapMode="word">{line}</text>
            )}
          </For>
        </box>
      )}
    </For>
  )
}

/**
 * Shared dialog chrome: header, tab bar, scrollable tab body, footer, and the
 * modal keymap layer that exists only while this component is mounted.
 */
function DashboardShell(props: {
  readonly tabs: readonly DashboardTab[]
  readonly initialTabId: string
  readonly colors: DashboardPalette
  readonly layout: () => DashboardLayout
  readonly layer: (factory: () => KeymapLayer) => void
  readonly header: (colors: DashboardPalette, layout: DashboardLayout) => JSX.Element
  readonly body: (tabId: string, colors: DashboardPalette, layout: DashboardLayout) => JSX.Element
}): JSX.Element {
  const dimensions = useTerminalDimensions()
  const [active, setActive] = createSignal(props.initialTabId)
  // Height budget: the shell (header + tab bar + footer + padding) needs
  // roughly 8-12 rows; the scroll area takes the rest so the root column
  // never exceeds the terminal/dialog height (overflow would compress the
  // header and overlap its rows).
  const maxHeight = createMemo(() => Math.max(6, dimensions().height - 12))

  let scroll: ScrollBoxRenderable | undefined
  const scrollBy = (delta: number) => {
    if (scroll && !scroll.isDestroyed) scroll.scrollBy(delta)
  }
  const select = (id: string) => {
    if (!props.tabs.some(tab => tab.id === id)) return
    setActive(id)
    if (scroll && !scroll.isDestroyed) scroll.scrollTop = 0
  }

  // Bindings live only while this dialog component is mounted (modal mode).
  props.layer(() => ({
    mode: "modal",
    commands: dashboardCommands(
      {
        tabs: props.tabs,
        current: active,
        select,
        pageSize: () => Math.max(3, Math.floor(maxHeight() * 0.6)),
      },
      scrollBy,
    ) as KeymapLayer["commands"],
  }))

  return (
    <box flexDirection="column" paddingBottom={1} paddingLeft={2} paddingRight={2}>
      {props.header(props.colors, props.layout())}
      <TabBar tabs={props.tabs} active={active} colors={props.colors} layout={props.layout()} />
      <scrollbox
        ref={(node: ScrollBoxRenderable) => {
          scroll = node
        }}
        maxHeight={maxHeight()}
        paddingLeft={1}
        paddingRight={1}
        scrollX={false}
      >
        {() => props.body(active(), props.colors, props.layout())}
      </scrollbox>
      <text fg={props.colors.muted}>{footerHint(props.layout())}</text>
    </box>
  )
}

// --- session tab bodies ------------------------------------------------------

function SessionOverviewTab(props: {
  readonly report: ReportPayload
  readonly colors: DashboardPalette
  readonly layout: DashboardLayout
}): JSX.Element {
  const report = props.report
  const composition = compositionBlock(report, props.layout)
  const insight = dominantConsumerInsight(report)
  return (
    <box flexDirection="column">
      <KpiView grid={kpiGrid(sessionKpis(report), props.layout)} colors={props.colors} />
      <SectionTitle title="Estimated input by section" colors={props.colors} />
      <text fg={props.colors.base}>
        <span {...spanAttrs(props.colors.info, undefined)}>≈</span>
        {` ${composition.totalText} tok total (heuristic estimate · exact numbers below)`}
      </text>
      <BarRows rows={composition.rows} colors={props.colors} />
      {insight === undefined ? null : <InsightLine text={insight.text} tone={insight.tone} colors={props.colors} />}
      <SectionTitle title="Message categories (est, % of messages)" colors={props.colors} />
      <TableView model={categoriesTable(report, props.layout)} colors={props.colors} />
      <NoteLines
        lines={["Estimates are local heuristics, not tokenizer output; provider counts are on the Usage tab, attribution notes on Details."]}
        colors={props.colors}
      />
    </box>
  )
}

function SessionToolsTab(props: {
  readonly report: ReportPayload
  readonly colors: DashboardPalette
  readonly layout: DashboardLayout
}): JSX.Element {
  const report = props.report
  const insight = topSchemaToolInsight(report)
  const groups = toolGroupsBlock(report, props.layout)
  return (
    <box flexDirection="column">
      {insight === undefined ? null : <InsightLine text={insight.text} tone={insight.tone} colors={props.colors} />}
      <SectionTitle title={`Tool schemas in the request (${report.tools.total} tools · top ${report.tools.ranked.length} shown)`} colors={props.colors} />
      <TableView model={toolSchemaTable(report, props.layout)} colors={props.colors} />
      {groups.length > 0 ? (
        <box flexDirection="column">
          <SectionTitle title="Groups (heuristic attribution)" colors={props.colors} />
          <BarRows rows={groups} colors={props.colors} />
        </box>
      ) : null}
      <SectionTitle title="Tool I/O in transcript (est · subset of messages, not additive)" colors={props.colors} />
      <TableView model={toolIOTable(report, props.layout)} colors={props.colors} />
      <NoteLines
        lines={[
          `Schema figures come from the direct per-request tool definitions, not the full registered catalog (${report.tools.total} tools in this snapshot).`,
          "Transcript I/O is already counted inside the messages total — never add it on top.",
        ]}
        colors={props.colors}
      />
    </box>
  )
}

function SessionHistoryTab(props: {
  readonly report: ReportPayload
  readonly colors: DashboardPalette
  readonly layout: DashboardLayout
  readonly lastN: number | undefined
}): JSX.Element {
  const history = historyModel(props.report, props.layout, props.lastN)
  return (
    <box flexDirection="column">
      <SectionTitle title={`Snapshot history (${history.points} shown of ${history.totalPoints})`} colors={props.colors} />
      <NoteLines lines={[history.note]} colors={props.colors} />
      <TableView model={history.table} colors={props.colors} />
    </box>
  )
}

function SessionUsageTab(props: {
  readonly report: ReportPayload
  readonly colors: DashboardPalette
  readonly layout: DashboardLayout
}): JSX.Element {
  const usage = sessionUsageModel(props.report, props.layout)
  return (
    <box flexDirection="column">
      <SectionTitle title="Provider-reported usage (actual counts, not estimates)" colors={props.colors} />
      {usage.available ? <KpiView grid={kpiGrid(usage.kpis, props.layout)} colors={props.colors} /> : null}
      <KeyValueRows rows={usage.kv} colors={props.colors} />
      {usage.auxiliary.length > 0 ? (
        <box flexDirection="column">
          <SectionTitle title="Auxiliary requests (never summed)" colors={props.colors} />
          <KeyValueRows rows={usage.auxiliary} colors={props.colors} />
        </box>
      ) : null}
      {usage.utilization !== undefined ? (
        <box flexDirection="column">
          <SectionTitle title="Context window (estimate over registry limit)" colors={props.colors} />
          <text>
            <span {...spanAttrs(props.colors.muted, undefined)}>{`${usage.utilization.label}  `}</span>
            <span {...spanAttrs(toneColor(usage.utilization.tone, props.colors), undefined)}>{"█".repeat(usage.utilization.bar.filled)}</span>
            <span {...spanAttrs(props.colors.barEmpty, undefined)}>{"░".repeat(usage.utilization.bar.empty)}</span>
            <span {...spanAttrs(props.colors.base, undefined)}>{` ${usage.utilization.value}`}</span>
            {usage.utilization.percent === undefined ? null : (
              <span {...spanAttrs(toneColor(usage.utilization.tone, props.colors), undefined)}>{` ${usage.utilization.percent}`}</span>
            )}
          </text>
        </box>
      ) : (
        <NoteLines lines={["Context-window limit unavailable from the model registry; utilization not computed."]} colors={props.colors} />
      )}
      <SectionTitle title="Notes" colors={props.colors} />
      <NoteLines lines={usage.notes} colors={props.colors} />
    </box>
  )
}

function SessionDetailsTab(props: {
  readonly report: ReportPayload
  readonly colors: DashboardPalette
  readonly layout: DashboardLayout
}): JSX.Element {
  return <ProseBlocks blocks={sessionDetails(props.report, props.layout)} colors={props.colors} />
}

function sessionTabBody(
  tabId: string,
  report: ReportPayload,
  plan: { readonly lastN?: number },
  colors: DashboardPalette,
  layout: DashboardLayout,
): JSX.Element {
  switch (tabId) {
    case "tools":
      return <SessionToolsTab report={report} colors={colors} layout={layout} />
    case "history":
      return <SessionHistoryTab report={report} colors={colors} layout={layout} lastN={plan.lastN} />
    case "usage":
      return <SessionUsageTab report={report} colors={colors} layout={layout} />
    case "details":
      return <SessionDetailsTab report={report} colors={colors} layout={layout} />
    default:
      return <SessionOverviewTab report={report} colors={colors} layout={layout} />
  }
}

/** Session dashboard: /context-doctor [short|detailed|tools] [N]. */
export function SessionDashboard(props: {
  readonly report: ReportPayload
  readonly plan: ReturnType<typeof sessionDialogPlan>
  readonly layer: (factory: () => KeymapLayer) => void
  readonly theme?: unknown
  readonly themeMode?: string
}): JSX.Element {
  const colors = paletteFrom(props.theme, props.themeMode)
  const dimensions = useTerminalDimensions()
  const layout = createMemo(() => layoutFor(dimensions().width))
  return (
    <DashboardShell
      tabs={props.plan.tabs}
      initialTabId={props.plan.initialTabId}
      colors={colors}
      layout={layout}
      layer={props.layer}
      header={(c, l) => {
        const model = sessionHeader(props.report, l)
        return <HeaderView colors={c} title={model.title} badge={model.badge} badgeTone={model.badgeTone} meta={model.meta} />
      }}
      body={(tabId, c, l) => sessionTabBody(tabId, props.report, props.plan, c, l)}
    />
  )
}

// --- all-sessions tab bodies ---------------------------------------------------

function AllOverviewTab(props: { readonly stats: GlobalStatsPayload; readonly colors: DashboardPalette; readonly layout: DashboardLayout }): JSX.Element {
  const stats = props.stats
  return (
    <box flexDirection="column">
      <KpiView grid={kpiGrid(allSessionsKpis(stats), props.layout)} colors={props.colors} />
      <SectionTitle title="Estimated context by model (per-session latest snapshot)" colors={props.colors} />
      <TableView model={perModelTable(stats, props.layout)} colors={props.colors} />
      <NoteLines
        lines={[
          "Per-session snapshot estimates only: repeated snapshots of one session are never summed as consumption. Reported usage lives on the Usage tab.",
        ]}
        colors={props.colors}
      />
    </box>
  )
}

function AllToolsTab(props: { readonly stats: GlobalStatsPayload; readonly colors: DashboardPalette; readonly layout: DashboardLayout }): JSX.Element {
  const tables = allSessionsToolTables(props.stats, props.layout)
  return (
    <box flexDirection="column">
      <SectionTitle title="Tool schema footprint (each session's latest context only)" colors={props.colors} />
      <TableView model={tables.schema} colors={props.colors} />
      <SectionTitle title="Tool transcript I/O (each session's latest context only)" colors={props.colors} />
      <TableView model={tables.io} colors={props.colors} />
      <NoteLines lines={["Totals aggregate each session's latest retained snapshot; repeated snapshots of the same session are never summed."]} colors={props.colors} />
    </box>
  )
}

function AllSessionsTab(props: { readonly stats: GlobalStatsPayload; readonly colors: DashboardPalette; readonly layout: DashboardLayout }): JSX.Element {
  return (
    <box flexDirection="column">
      <SectionTitle title={`Newest sessions (top ${props.stats.sessions.length})`} colors={props.colors} />
      <TableView model={allSessionsSessionsTable(props.stats, props.layout)} colors={props.colors} />
    </box>
  )
}

function AllUsageTab(props: { readonly stats: GlobalStatsPayload; readonly colors: DashboardPalette; readonly layout: DashboardLayout }): JSX.Element {
  const usage = allSessionsUsageModel(props.stats)
  return (
    <box flexDirection="column">
      <SectionTitle title="Provider-reported usage totals (not estimates)" colors={props.colors} />
      {usage.available ? <KpiView grid={kpiGrid(usage.kpis, props.layout)} colors={props.colors} /> : <NoteLines lines={["No sessions observed with provider-reported usage yet."]} colors={props.colors} />}
      <KeyValueRows rows={usage.kv} colors={props.colors} />
    </box>
  )
}

function AllDetailsTab(props: { readonly stats: GlobalStatsPayload; readonly colors: DashboardPalette; readonly layout: DashboardLayout }): JSX.Element {
  return <ProseBlocks blocks={allSessionsDetails(props.stats, props.layout)} colors={props.colors} />
}

function allSessionsTabBody(tabId: string, stats: GlobalStatsPayload, colors: DashboardPalette, layout: DashboardLayout): JSX.Element {
  switch (tabId) {
    case "tools":
      return <AllToolsTab stats={stats} colors={colors} layout={layout} />
    case "sessions":
      return <AllSessionsTab stats={stats} colors={colors} layout={layout} />
    case "usage":
      return <AllUsageTab stats={stats} colors={colors} layout={layout} />
    case "details":
      return <AllDetailsTab stats={stats} colors={colors} layout={layout} />
    default:
      return <AllOverviewTab stats={stats} colors={colors} layout={layout} />
  }
}

/** All-sessions dashboard: /context-doctor all (cross-location aggregate). */
export function AllSessionsDashboard(props: {
  readonly stats: GlobalStatsPayload
  readonly layer: (factory: () => KeymapLayer) => void
  readonly theme?: unknown
  readonly themeMode?: string
}): JSX.Element {
  const colors = paletteFrom(props.theme, props.themeMode)
  const dimensions = useTerminalDimensions()
  const layout = createMemo(() => layoutFor(dimensions().width))
  if (!props.stats.available) {
    return (
      <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={colors.heading} attributes={TextAttributes.BOLD}>Context Doctor · all sessions</text>
        <text fg={colors.error}>Unavailable: {props.stats.reason ?? "unknown"}</text>
        <text fg={colors.muted} wrapMode="word">Per-session reports continue to work from memory; disk persistence is not active.</text>
        <text fg={colors.muted}>esc close</text>
      </box>
    )
  }
  return (
    <DashboardShell
      tabs={ALL_SESSIONS_TABS}
      initialTabId="overview"
      colors={colors}
      layout={layout}
      layer={props.layer}
      header={(c, l) => {
        const model = allSessionsHeader(props.stats, l)
        return <HeaderView colors={c} title={model.title} badge={model.badge} badgeTone={model.badgeTone} meta={model.meta} />
      }}
      body={(tabId, c, l) => allSessionsTabBody(tabId, props.stats, c, l)}
    />
  )
}

// ---------------------------------------------------------------------------
// Plugin wiring
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "context-doctor.tui",
  setup(context) {
    const doctorRpc = context.client.rpc(ContextDoctor)

    const currentLocation = () => context.location ?? context.data.location.default()
    /** The report targets the session's own location; fall back to the TUI's. */
    const sessionLocation = async (sessionID: string) => {
      let info = context.data.session.get(sessionID)
      if (!info?.location) {
        try {
          await context.data.session.sync(sessionID)
        } catch {
          // Keep the fallback location.
        }
        info = context.data.session.get(sessionID)
      }
      return info?.location ?? currentLocation()
    }

    const rpc: ContextDoctorRpcLike = {
      list: async () => {
        const output = (await doctorRpc.list({}, { location: currentLocation() })) as unknown as ListPayload
        return output
      },
      report: async sessionID => {
        const output = (await doctorRpc.report({ sessionID }, { location: await sessionLocation(sessionID) })) as unknown as ReportPayload
        return output
      },
      stats: async () => {
        // Any location's instance answers from the shared per-user database.
        const output = (await doctorRpc.stats({ topN: 15 }, { location: currentLocation() })) as unknown as GlobalStatsPayload
        return output
      },
    }

    const showDialog = (render: () => JSX.Element) => {
      context.ui.dialog.show(render)
      context.ui.dialog.set({ size: "xlarge", centered: true })
    }

    let busy = false
    const run = async (args?: string) => {
      if (busy) return
      busy = true
      try {
        await runContextDoctor(
          {
            rpc,
            currentSessionID: () => {
              const route = context.ui.router.current()
              return route.type === "session" ? route.sessionID : undefined
            },
            dialog: {
              select: options => context.ui.dialog.select(options),
              show: (render, onClose) => context.ui.dialog.show(render, onClose),
              set: options => context.ui.dialog.set(options),
              alert: options => context.ui.dialog.alert(options),
            },
            renderReport: (report, formatOptions) => {
              showDialog(() => (
                <SessionDashboard
                  report={report}
                  plan={sessionDialogPlan(formatOptions)}
                  layer={context.keymap.layer}
                  theme={context.theme}
                  themeMode={context.themeMode}
                />
              ))
            },
            renderStats: stats => {
              showDialog(() => (
                <AllSessionsDashboard
                  stats={stats}
                  layer={context.keymap.layer}
                  theme={context.theme}
                  themeMode={context.themeMode}
                />
              ))
            },
            toast: options => context.ui.toast.show(options),
          },
          args,
        )
      } finally {
        busy = false
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "context-doctor.report",
          title: "Context Doctor report",
          description:
            "Context analytics dashboard for the current session: estimated system/message/tool-schema tokens with tabs (Overview/Tools/History/Usage/Details). Arguments: [short|detailed|tools|all] [lastN].",
          group: "Context Doctor",
          palette: true,
          slash: { name: "context-doctor", arguments: true },
          suggested: true,
          run: input => void run(input),
        },
      ],
    }))
  },
})
