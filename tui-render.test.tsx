/**
 * Isolated-renderer verification of the dashboard dialog.
 *
 * Mounts the real components on an offscreen OpenTUI test renderer (no TTY,
 * no host app) and asserts on captured character frames: the dashboard
 * renders, tabs switch through the modal keymap layer commands, narrow
 * terminals never clip horizontally, and the layer is registered once per
 * mount (bindings exist only while the dialog is mounted — the host removes
 * the layer when the component is disposed).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { AllSessionsDashboard, SessionDashboard } from "./tui.tsx"
import { sessionDialogPlan } from "./dashboard.ts"
import { fixtureReport, fixtureStats } from "./fixtures.ts"

type LayerFactory = () => KeymapLayer

function makeLayerCollector() {
  const factories: LayerFactory[] = []
  return {
    factories,
    layer: (factory: LayerFactory) => {
      factories.push(factory)
    },
  }
}

interface Mounted {
  setup: TestRendererSetup
  collector: ReturnType<typeof makeLayerCollector>
  commands: () => readonly { id: string; bind: string; run: () => void }[]
}

async function mountSession(options: { width?: number; height?: number; mode?: "overview" | "tools" } = {}): Promise<Mounted & { collector: ReturnType<typeof makeLayerCollector> }> {
  const collector = makeLayerCollector()
  const plan = sessionDialogPlan(options.mode === "tools" ? { mode: "tools" } : {})
  const setup = await testRender(
    () => <SessionDashboard report={fixtureReport()} plan={plan} layer={collector.layer} />,
    { width: options.width ?? 100, height: options.height ?? 32 },
  )
  await setup.flush()
  return {
    setup,
    collector,
    commands: () => {
      assert.equal(collector.factories.length, 1, "exactly one layer factory must be registered per mount")
      return (collector.factories[0]!().commands ?? []) as readonly { id: string; bind: string; run: () => void }[]
    },
  }
}

async function mountAllSessions(width = 100, height = 32): Promise<Mounted & { collector: ReturnType<typeof makeLayerCollector> }> {
  const collector = makeLayerCollector()
  const setup = await testRender(
    () => <AllSessionsDashboard stats={fixtureStats()} layer={collector.layer} />,
    { width, height },
  )
  await setup.flush()
  return {
    setup,
    collector,
    commands: () => {
      assert.equal(collector.factories.length, 1)
      return (collector.factories[0]!().commands ?? []) as readonly { id: string; bind: string; run: () => void }[]
    },
  }
}

function frameLines(frame: string): string[] {
  return frame.split("\n").map(line => line.replace(/\s+$/, ""))
}

test("session dashboard renders header, tab bar, KPI row, and composition bars", async () => {
  const mounted = await mountSession()
  const report = fixtureReport()
  const frame = mounted.setup.captureCharFrame()
  for (const expected of [
    "Context Doctor",
    "Overview",
    "Tools",
    "History",
    "Usage",
    "Details",
    "est. input",
    "context",
    "messages",
    "model",
    "Estimated input by section",
    "system",
    "tool schemas",
    "1-5 tabs",
    "esc close",
  ]) {
    assert.ok(frame.includes(expected), `frame missing "${expected}"`)
  }
  // Bars use block cells, not ascii hashes.
  assert.ok(frame.includes("█"), "block bar cells missing")
  assert.ok(!frame.includes("##########"), "old ascii bars must not appear")
  // Utilization KPI shows the fixture's estimate/window percentage.
  const expectedPct = `${report.reported.utilizationEstimatedPct!.toFixed(1)}%`
  assert.ok(frame.includes(expectedPct), `context utilization ${expectedPct} missing`)
  await mounted.setup.dispose()
})

test("modal layer registers once, is modal, and stays single across tab switches", async () => {
  const mounted = await mountSession()
  const layer = mounted.collector.factories[0]!()
  assert.equal(layer.mode, "modal")
  const commands = mounted.commands()
  assert.ok(commands.some(command => command.bind === "escape" || command.id === "context-doctor.tab.tools"))
  const runTwo = commands.find(command => command.bind === "2")
  assert.ok(runTwo, "digit tab command missing")
  runTwo!.run()
  await mounted.setup.flush()
  assert.equal(mounted.collector.factories.length, 1, "tab switches must not re-register layers")
  await mounted.setup.dispose()
})

test("tabs switch through digit and arrow commands and render their content", async () => {
  const mounted = await mountSession()
  const frame0 = mounted.setup.captureCharFrame()
  assert.ok(frame0.includes("▌1 Overview"), "active tab indicator missing")

  // Digit "2" -> Tools tab: schema table appears.
  mounted.commands().find(command => command.bind === "2")!.run()
  await mounted.setup.flush()
  const toolsFrame = mounted.setup.captureCharFrame()
  assert.ok(toolsFrame.includes("▌2 Tools"), "active tab did not move to Tools")
  assert.ok(toolsFrame.includes("Tool schemas in the request"), "tools section missing")
  assert.ok(toolsFrame.includes("github_create_issue"), "ranked tool row missing")

  // Arrow right -> History tab.
  mounted.commands().find(command => command.bind === "right")!.run()
  await mounted.setup.flush()
  assert.ok(mounted.setup.captureCharFrame().includes("Snapshot history"), "history section missing")

  // Arrow right -> Usage tab: provider-reported KPIs appear.
  mounted.commands().find(command => command.bind === "right")!.run()
  await mounted.setup.flush()
  const usageFrame = mounted.setup.captureCharFrame()
  assert.ok(usageFrame.includes("Provider-reported usage"), "usage section missing")
  assert.ok(usageFrame.includes("190k"), "cumulative input KPI missing")

  // "5" -> Details tab: caveats present, no wall of text on other tabs.
  mounted.commands().find(command => command.bind === "5")!.run()
  await mounted.setup.flush()
  const detailsFrame = mounted.setup.captureCharFrame()
  assert.ok(detailsFrame.includes("Estimation (heuristic, local)"), "estimation details missing")
  // The limits block sits below the fold: jump to the bottom and verify its
  // content scrolled into view (and the top scrolled out).
  mounted.commands().find(command => command.bind === "end")!.run()
  await mounted.setup.flush()
  const bottomFrame = mounted.setup.captureCharFrame()
  assert.ok(bottomFrame.includes("unattributed"), "limits content missing after scrolling to bottom")
  assert.ok(!bottomFrame.includes("id ses_test"), "jump-to-bottom must scroll the session block out of view")
  await mounted.setup.dispose()
})

test("'tools' argument opens directly on the Tools tab", async () => {
  const mounted = await mountSession({ mode: "tools" })
  const frame = mounted.setup.captureCharFrame()
  assert.ok(frame.includes("▌2 Tools"), "tools mode must start on the Tools tab")
  assert.ok(frame.includes("github_create_issue"))
  await mounted.setup.dispose()
})

test("narrow terminals never clip horizontally (46 columns)", async () => {
  const mounted = await mountSession({ width: 46, height: 30 })
  for (const tabBind of ["1", "2", "3", "4", "5"]) {
    mounted.commands().find(command => command.bind === tabBind)!.run()
    await mounted.setup.flush()
    const frame = mounted.setup.captureCharFrame()
    for (const line of frameLines(frame)) {
      assert.ok(line.length <= 46, `clipped line (${line.length} > 46): "${line}"`)
    }
  }
  await mounted.setup.dispose()
})

test("resizing adapts the layout without remounting", async () => {
  const mounted = await mountSession({ width: 100, height: 32 })
  mounted.setup.resize(58, 24)
  await mounted.setup.flush()
  const frame = mounted.setup.captureCharFrame()
  for (const line of frameLines(frame)) {
    assert.ok(line.length <= 58, `clipped line after resize (${line.length} > 58): "${line}"`)
  }
  assert.ok(frame.includes("est. input"), "KPIs must survive resize")
  await mounted.setup.dispose()
})

test("long prose wraps instead of overflowing", async () => {
  const mounted = await mountSession({ width: 64, height: 40 })
  mounted.commands().find(command => command.bind === "5")!.run()
  await mounted.setup.flush()
  const frame = mounted.setup.captureCharFrame()
  for (const line of frameLines(frame)) {
    assert.ok(line.length <= 64, `details line clipped (${line.length} > 64): "${line}"`)
  }
  await mounted.setup.dispose()
})

test("all-sessions dashboard renders coverage badge, KPIs, and its tabs", async () => {
  const mounted = await mountAllSessions()
  const frame = mounted.setup.captureCharFrame()
  for (const expected of ["Context Doctor · all sessions", "captured only", "Overview", "Sessions", "avg latest", "peak"]) {
    assert.ok(frame.includes(expected), `frame missing "${expected}"`)
  }
  mounted.commands().find(command => command.bind === "3")!.run()
  await mounted.setup.flush()
  const sessionsFrame = mounted.setup.captureCharFrame()
  assert.ok(sessionsFrame.includes("Newest sessions"), "sessions tab missing")
  await mounted.setup.dispose()
})

test("all-sessions unavailable state renders a clear message, not a broken dashboard", async () => {
  const collector = makeLayerCollector()
  const stats = { ...fixtureStats(), available: false, reason: "disabled" }
  const setup = await testRender(() => <AllSessionsDashboard stats={stats} layer={collector.layer} />, { width: 80, height: 20 })
  await setup.flush()
  const frame = setup.captureCharFrame()
  const unwrapped = frame.split("\n").join(" ").replace(/\s+/g, " ")
  assert.ok(unwrapped.includes("Unavailable: disabled"), "unavailable reason missing")
  assert.ok(unwrapped.includes("disk persistence is not active"), "guidance text missing")
  await setup.dispose()
})
