/**
 * Offline TUI preview harness: renders the /context-doctor dashboards on an
 * isolated OpenTUI test renderer (no TTY, no host app) and writes character
 * frames for several terminal sizes and tabs. Used for visual verification
 * during development; the same coverage is asserted in tui-render.test.tsx.
 *
 * Usage: bun run preview [outPath]
 *
 * The default output is a transient file in the OS temp directory (override
 * with the first argument or an explicit docs path when you want to keep it).
 */
import "@opentui/solid/preload"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { AllSessionsDashboard, SessionDashboard } from "./tui.tsx"
import { sessionDialogPlan } from "./dashboard.ts"
import { fixtureReport, fixtureStats } from "./fixtures.ts"

const OUT = process.argv[2] ?? join(tmpdir(), "context-doctor-preview.txt")

type Command = { id: string; bind: string; run: () => void }

function collector() {
  const factories: (() => KeymapLayer)[] = []
  return {
    factories,
    layer: (factory: () => KeymapLayer) => {
      factories.push(factory)
    },
  }
}

interface Preview {
  readonly title: string
  readonly width: number
  readonly height: number
  readonly tab?: string
}

const SESSION_PREVIEWS: readonly Preview[] = [
  { title: "session · wide 110x34 · Overview", width: 110, height: 34 },
  { title: "session · wide 110x34 · Tools", width: 110, height: 34, tab: "2" },
  { title: "session · wide 110x34 · History", width: 110, height: 34, tab: "3" },
  { title: "session · wide 110x34 · Usage", width: 110, height: 34, tab: "4" },
  { title: "session · wide 110x34 · Details", width: 110, height: 34, tab: "5" },
  { title: "session · medium 76x30 · Overview", width: 76, height: 30 },
  { title: "session · medium 76x30 · Tools", width: 76, height: 30, tab: "2" },
  { title: "session · narrow 46x26 · Overview", width: 46, height: 26 },
  { title: "session · narrow 46x26 · Tools", width: 46, height: 26, tab: "2" },
]

const ALL_PREVIEWS: readonly Preview[] = [
  { title: "all-sessions · wide 110x34 · Overview", width: 110, height: 34 },
  { title: "all-sessions · wide 110x34 · Sessions", width: 110, height: 34, tab: "3" },
]

// Simple sequential mount per preview (clearest output, still fast).
async function runSessionPreview(preview: Preview): Promise<string> {
  const plan = sessionDialogPlan({})
  const c = collector()
  const setup = await testRender(
    () => <SessionDashboard report={fixtureReport()} plan={plan} layer={c.layer} />,
    { width: preview.width, height: preview.height },
  )
  await setup.flush()
  const commands = () => (c.factories[0]!().commands ?? []) as readonly Command[]
  if (preview.tab) {
    commands().find(command => command.bind === preview.tab)!.run()
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  const frame = setup.captureCharFrame()
  await setup.dispose()
  return `\n===== ${preview.title} =====\n${frame}`
}

async function runAllSessionsPreview(preview: Preview): Promise<string> {
  const c = collector()
  const setup = await testRender(
    () => <AllSessionsDashboard stats={fixtureStats()} layer={c.layer} />,
    { width: preview.width, height: preview.height },
  )
  await setup.flush()
  const commands = () => (c.factories[0]!().commands ?? []) as readonly Command[]
  if (preview.tab) {
    commands().find(command => command.bind === preview.tab)!.run()
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  const frame = setup.captureCharFrame()
  await setup.dispose()
  return `\n===== ${preview.title} =====\n${frame}`
}

const parts: string[] = []
for (const preview of SESSION_PREVIEWS) parts.push(await runSessionPreview(preview))
for (const preview of ALL_PREVIEWS) parts.push(await runAllSessionsPreview(preview))
const out = parts.join("\n")
writeFileSync(OUT, out)
console.log(`wrote ${OUT} (${out.length} chars)`)
