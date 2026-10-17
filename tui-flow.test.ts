import test from "node:test"
import assert from "node:assert/strict"
import { RGBA } from "@opentui/core"
import { dashboardCommands, paletteFrom, runContextDoctor, type ContextDoctorRpcLike, type ReportFlowDeps } from "./tui.tsx"
import { formatReportLines, parseReportArgs, type FormatOptions } from "./format.ts"
import { sessionDialogPlan } from "./dashboard.ts"
import type { GlobalStatsPayload, ListPayload, ReportPayload } from "./types.ts"
import { fixtureReport, fixtureStats } from "./fixtures.ts"

interface RenderedCall {
  report: ReportPayload
  options: FormatOptions
  lines: readonly string[]
}

interface DepsOverrides {
  currentSessionID?: string
  report?: ReportPayload
  list?: ListPayload
  stats?: GlobalStatsPayload
  statsError?: unknown
  error?: unknown
}

function makeDeps(overrides: DepsOverrides = {}) {
  const calls: {
    list: number
    report: string[]
    stats: number
    selected: unknown
    alerts: string[]
    toasts: string[]
    rendered: RenderedCall[]
    renderedStats: GlobalStatsPayload[]
  } = { list: 0, report: [], stats: 0, selected: undefined, alerts: [], toasts: [], rendered: [], renderedStats: [] }

  const rpc: ContextDoctorRpcLike = {
    list: async () => {
      calls.list += 1
      if (overrides.list === undefined) throw new Error("list not expected in this flow")
      return overrides.list
    },
    report: async sessionID => {
      calls.report.push(sessionID)
      if (overrides.error) throw overrides.error
      if (overrides.report === undefined) throw new Error("report not expected in this flow")
      return overrides.report
    },
    stats: async () => {
      calls.stats += 1
      if (overrides.statsError !== undefined) throw overrides.statsError
      return overrides.stats ?? fixtureStats()
    },
  }

  const deps: ReportFlowDeps = {
    rpc,
    currentSessionID: () => overrides.currentSessionID,
    dialog: {
      select: async <T,>(options: { options: readonly { value: T }[] }) => {
        calls.selected = options.options[0]?.value
        return options.options[0]?.value as T | undefined
      },
      show: () => {},
      set: () => {},
      alert: async options => {
        calls.alerts.push(options.message)
      },
    },
    renderReport: (report, options) => {
      calls.rendered.push({ report, options, lines: formatReportLines(report, options) })
    },
    renderStats: stats => {
      calls.renderedStats.push(stats)
    },
    toast: options => calls.toasts.push(options.message),
  }
  return { deps, calls }
}

const summary = (sessionID: string): ListPayload["sessions"][number] => ({
  sessionID,
  agent: "build",
  model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
  snapshotCount: 1,
  lastCapturedAt: 1,
  lastEstimatedInputTokens: 2,
  lastMessageCount: 3,
  hookErrorCount: 0,
  lastActiveAt: 4,
})

test("with a current session the report is fetched and rendered directly", async () => {
  const { deps, calls } = makeDeps({ currentSessionID: "ses_current", report: fixtureReport() })
  await runContextDoctor(deps)
  assert.deepEqual(calls.report, ["ses_current"])
  assert.equal(calls.list, 0)
  assert.equal(calls.rendered.length, 1)
  assert.deepEqual(calls.rendered[0]!.options, {})
})

test("arguments are forwarded: 'tools 5' selects tools mode with lastN and opens the Tools tab", async () => {
  const { deps, calls } = makeDeps({ currentSessionID: "ses_current", report: fixtureReport() })
  await runContextDoctor(deps, "tools 5")
  assert.deepEqual(calls.rendered[0]!.options, { mode: "tools", lastN: 5 })
  const plan = sessionDialogPlan(parseReportArgs("tools 5"))
  assert.equal(plan.initialTabId, "tools")
  assert.equal(plan.lastN, 5)
})

test("legacy 'short' and 'detailed' modes open on the Overview tab", () => {
  assert.equal(sessionDialogPlan(parseReportArgs("short")).initialTabId, "overview")
  assert.equal(sessionDialogPlan(parseReportArgs("detailed")).initialTabId, "overview")
  assert.equal(sessionDialogPlan(parseReportArgs("")).initialTabId, "overview")
  assert.equal(sessionDialogPlan(parseReportArgs("banana")).initialTabId, "overview")
})

test("'all' renders the cross-location stats view without touching session flow", async () => {
  const { deps, calls } = makeDeps({ currentSessionID: "ses_current", report: fixtureReport() })
  await runContextDoctor(deps, "all")
  assert.equal(calls.stats, 1)
  assert.equal(calls.rendered.length, 0, "session report must not render for the stats view")
  assert.equal(calls.renderedStats.length, 1)
})

test("'stats' is an alias of 'all'; stats failures surface as a toast", async () => {
  const alias = makeDeps({})
  await runContextDoctor(alias.deps, "stats")
  assert.equal(alias.calls.renderedStats.length, 1)

  const failing = makeDeps({ statsError: new Error("database unavailable") })
  await runContextDoctor(failing.deps, "all")
  assert.equal(failing.calls.renderedStats.length, 0)
  assert.match(failing.calls.toasts[0]!, /all-sessions stats/)
})

test("without a current session, an empty tracker alerts and a populated one opens a picker", async () => {
  const empty = makeDeps({ list: { sessions: [] } })
  await runContextDoctor(empty.deps)
  assert.equal(empty.calls.alerts.length, 1)
  assert.equal(empty.calls.rendered.length, 0)

  const populated = makeDeps({ list: { sessions: [summary("ses_picked")] }, report: fixtureReport() })
  await runContextDoctor(populated.deps)
  assert.deepEqual(populated.calls.report, ["ses_picked"])
  assert.equal(populated.calls.rendered.length, 1)
})

test("picker cancellation renders nothing", async () => {
  const custom = makeDeps({ list: { sessions: [summary("ses_x")] } })
  custom.deps.dialog.select = async () => undefined
  await runContextDoctor(custom.deps)
  assert.equal(custom.calls.rendered.length, 0)
  assert.equal(custom.calls.report.length, 0)
})

test("list failures surface as a toast", async () => {
  const failing = makeDeps({ list: { sessions: [] } })
  failing.deps.rpc.list = async () => {
    throw new Error("registry unavailable")
  }
  await runContextDoctor(failing.deps)
  assert.equal(failing.calls.toasts.length, 1)
  assert.match(failing.calls.toasts[0]!, /registry unavailable/)
})

test("unknown_session errors become alerts; other errors become toasts", async () => {
  const unknown = makeDeps({ currentSessionID: "ses_a", error: Object.assign(new Error("no snapshot"), { type: "unknown_session" }) })
  await runContextDoctor(unknown.deps)
  assert.equal(unknown.calls.alerts.length, 1)
  assert.equal(unknown.calls.toasts.length, 0)

  const generic = makeDeps({ currentSessionID: "ses_a", error: new Error("connection refused") })
  await runContextDoctor(generic.deps)
  assert.equal(generic.calls.alerts.length, 0)
  assert.equal(generic.calls.toasts.length, 1)
  assert.match(generic.calls.toasts[0]!, /connection refused/)
})

test("dashboard commands scroll with expected deltas, including a custom page size", () => {
  const deltas: number[] = []
  const commands = dashboardCommands(
    { tabs: [{ id: "overview" }, { id: "tools" }], current: () => "overview", select: () => {}, pageSize: () => 12 },
    (delta: number) => deltas.push(delta),
  )
  const byBind = new Map(commands.map(command => [command.bind, command.run]))
  for (const bind of ["up", "down", "pageup", "pagedown", "home", "end", "g", "G"]) assert.ok(byBind.has(bind), `missing bind ${bind}`)
  byBind.get("up")!()
  byBind.get("down")!()
  byBind.get("pageup")!()
  byBind.get("pagedown")!()
  byBind.get("home")!()
  byBind.get("end")!()
  byBind.get("g")!()
  byBind.get("G")!()
  assert.deepEqual(deltas, [-1, 1, -12, 12, -1_000_000, 1_000_000, -1_000_000, 1_000_000])
  for (const command of commands) {
    assert.equal(command.group, "Context Doctor")
    assert.ok(command.id.startsWith("context-doctor."))
  }
})

test("dashboard commands switch tabs with digits and wrap around with left/right", () => {
  const selected: string[] = []
  let current = "overview"
  const nav = {
    tabs: [
      { id: "overview", title: "Overview" },
      { id: "tools", title: "Tools" },
      { id: "history", title: "History" },
      { id: "usage", title: "Usage" },
      { id: "details", title: "Details" },
    ],
    current: () => current,
    select: (id: string) => {
      current = id
      selected.push(id)
    },
  }
  const commands = dashboardCommands(nav, () => {})
  const byBind = new Map(commands.map(command => [command.bind, command.run]))

  byBind.get("2")!()
  byBind.get("right")!()
  byBind.get("right")!()
  byBind.get("right")!()
  byBind.get("right")!() // wraps back to overview
  byBind.get("left")!()  // wraps back to details
  assert.deepEqual(selected, ["tools", "history", "usage", "details", "overview", "details"])

  // Digit commands exist for every tab and carry stable ids.
  const digitCommands = commands.filter(command => command.id.startsWith("context-doctor.tab.") && /^\d$/.test(command.bind))
  assert.deepEqual(digitCommands.map(command => command.id), [
    "context-doctor.tab.overview",
    "context-doctor.tab.tools",
    "context-doctor.tab.history",
    "context-doctor.tab.usage",
    "context-doctor.tab.details",
  ])
  assert.deepEqual(digitCommands.map(command => command.bind), ["1", "2", "3", "4", "5"])
})

test("palette prefers semantic theme tokens, converts RGBA, and falls back per mode", () => {
  const themed = paletteFrom({ text: { base: "#token-base", muted: "#token-muted" }, accent: { base: "#token-accent" } }, "dark")
  assert.equal(themed.base, "#token-base")
  assert.equal(themed.muted, "#token-muted")
  assert.equal(themed.heading, "#token-accent")
  assert.equal(themed.accent, "#token-accent")

  // ResolvedTheme shape: RGBA instances on text/action/feedback tokens.
  const resolved = paletteFrom(
    {
      text: {
        base: RGBA.fromInts(0xe6, 0xed, 0xf3),
        muted: RGBA.fromInts(0x8b, 0x94, 0x9e),
        action: { primary: { base: RGBA.fromInts(0x58, 0xa6, 0xff) } },
        feedback: {
          success: { base: RGBA.fromInts(0x3f, 0xb9, 0x50) },
          warning: { base: RGBA.fromInts(0xd2, 0x99, 0x22) },
          error: { base: RGBA.fromInts(0xf8, 0x51, 0x49) },
          info: { base: RGBA.fromInts(0x58, 0xa6, 0xff) },
        },
      },
      border: { base: RGBA.fromInts(0x3d, 0x44, 0x4d) },
    },
    "dark",
  )
  assert.equal(resolved.base.toLowerCase(), "#e6edf3")
  assert.equal(resolved.accent.toLowerCase(), "#58a6ff")
  assert.equal(resolved.success.toLowerCase(), "#3fb950")
  assert.equal(resolved.border.toLowerCase(), "#3d444d")

  const dark = paletteFrom(undefined, "dark")
  assert.equal(dark.base, "#e6edf3")
  const light = paletteFrom({}, "light")
  assert.equal(light.base, "#1f2328")
  assert.equal(light.muted, "#59636e")
})
