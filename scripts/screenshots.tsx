/**
 * Screenshot harness: renders the /context-doctor dashboards on an isolated
 * OpenTUI test renderer (no TTY, no host app, no real telemetry) and converts
 * the captured color span frames into PNG images for docs/screenshots.
 *
 * Everything rendered here comes from fixtures.ts — synthetic demo data only.
 * The frames are the real component output (same renderer as the tests), so
 * the images cannot drift from the actual UI. The PNG step needs a local
 * SVG rasterizer: rsvg-convert (librsvg) or ImageMagick (magick/convert).
 *
 * Usage: bun run screenshots [docs/screenshots]
 */
import "@opentui/solid/preload"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { TextAttributes, ansi256IndexToRgb, rgbToHex, type RGBA } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { AllSessionsDashboard, SessionDashboard } from "../tui.tsx"
import { sessionDialogPlan } from "../dashboard.ts"
import { fixtureReport, fixtureStats } from "../fixtures.ts"

type CapturedFrame = ReturnType<TestRendererSetup["captureSpans"]>
type CapturedSpan = CapturedFrame["lines"][number]["spans"][number]

const OUT_DIR = process.argv[2] ?? resolve(fileURLToPath(new URL("../docs/screenshots", import.meta.url)))

// Terminal look: GitHub-dark backdrop matches the plugin's static dark palette.
const BACKDROP = "#0d1117"
const DEFAULT_FG = "#e6edf3"
const CAPTION_FG = "#8b949e"
const FONT_STACK = "Menlo, 'DejaVu Sans Mono', Consolas, 'Courier New', monospace"
const FONT_SIZE = 15
// Menlo and DejaVu Sans Mono both advance 602/1000 em per cell; box-drawing
// glyphs connect exactly when the cell pitch equals the glyph advance.
const PITCH = FONT_SIZE * 0.602
const LINE_H = 20
const PAD = 12
const CAPTION_H = 22

interface Shot {
  readonly name: string
  readonly kind: "session" | "all"
  readonly width: number
  readonly height: number
  readonly tab?: string
  readonly caption: string
}

const SHOTS: readonly Shot[] = [
  { name: "overview-wide", kind: "session", width: 110, height: 34, caption: "session report · Overview tab · 110-column terminal" },
  { name: "tools-wide", kind: "session", width: 110, height: 34, tab: "2", caption: "session report · Tools tab · 110-column terminal" },
  { name: "all-sessions-wide", kind: "all", width: 110, height: 34, caption: "all-sessions statistics (/context-doctor all) · Overview tab" },
  { name: "overview-narrow", kind: "session", width: 46, height: 26, caption: "session report · Overview tab · narrow 46-column terminal" },
]

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

async function captureFrame(shot: Shot): Promise<CapturedFrame> {
  const c = collector()
  const setup =
    shot.kind === "session"
      ? await testRender(
          () => <SessionDashboard report={fixtureReport()} plan={sessionDialogPlan({})} layer={c.layer} />,
          { width: shot.width, height: shot.height },
        )
      : await testRender(() => <AllSessionsDashboard stats={fixtureStats()} layer={c.layer} />, {
          width: shot.width,
          height: shot.height,
        })
  await setup.flush()
  if (shot.tab) {
    const commands = () => (c.factories[0]!().commands ?? []) as readonly Command[]
    commands().find(command => command.bind === shot.tab)!.run()
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  const frame = setup.captureSpans()
  // Anti-fabrication guard: the span frame used for the SVG must contain the
  // exact same characters as the plain character frame the tests assert on.
  const charLines = setup.captureCharFrame().split("\n").map(line => line.trimEnd())
  const spanLines = frame.lines.map(line => line.spans.map(span => span.text).join("").trimEnd())
  for (const [row, spanLine] of spanLines.entries()) {
    if (spanLine !== charLines[row]) {
      throw new Error(`span frame diverges from character frame at row ${row} of ${shot.name}`)
    }
  }
  await setup.dispose()
  return frame
}

// --- span -> SVG ---------------------------------------------------------------

function colorOf(rgba: RGBA | undefined, fallback: string | undefined): string | undefined {
  if (!rgba) return fallback
  try {
    if (rgba.intent === "default" || rgba.a === 0) return fallback
    if (rgba.intent === "indexed") {
      const [r, g, b] = ansi256IndexToRgb(rgba.slot)
      return `#${[r, g, b].map(v => v.toString(16).padStart(2, "0")).join("")}`
    }
    const hex = rgbToHex(rgba)
    return hex.startsWith("#") ? hex : fallback
  } catch {
    return fallback
  }
}

function charCols(ch: string): number {
  const cp = ch.codePointAt(0)!
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!)
}

/** Solid block glyphs are drawn as filled rects so bar cells never show seams. */
function blockRects(ch: string, x: number, y: number, fill: string): string | null {
  switch (ch) {
    case "█":
      return `<rect x="${x}" y="${y}" width="${PITCH}" height="${LINE_H}" fill="${fill}"/>`
    case "▌":
      return `<rect x="${x}" y="${y}" width="${PITCH / 2}" height="${LINE_H}" fill="${fill}"/>`
    case "▐":
      return `<rect x="${x + PITCH / 2}" y="${y}" width="${PITCH / 2}" height="${LINE_H}" fill="${fill}"/>`
    case "▀":
      return `<rect x="${x}" y="${y}" width="${PITCH}" height="${LINE_H / 2}" fill="${fill}"/>`
    case "▄":
      return `<rect x="${x}" y="${y + LINE_H / 2}" width="${PITCH}" height="${LINE_H / 2}" fill="${fill}"/>`
    default:
      return null
  }
}

function spanVisible(span: CapturedSpan): boolean {
  return span.text.trim().length > 0 || colorOf(span.bg, undefined) !== undefined
}

export function frameToSvg(frame: CapturedFrame, caption: string): string {
  // Trim trailing blank rows/columns so images stay tight.
  let rows = 0
  let cols = 0
  frame.lines.forEach((line, row) => {
    if (line.spans.some(spanVisible)) rows = row + 1
    let col = 0
    for (const span of line.spans) {
      if (spanVisible(span)) cols = Math.max(cols, col + span.width)
      col += span.width
    }
  })
  rows = Math.max(rows, 1)
  cols = Math.max(cols, 1)

  const width = Math.ceil(PAD * 2 + cols * PITCH)
  const height = PAD * 2 + rows * LINE_H + CAPTION_H
  const baseline = PAD + LINE_H / 2 + FONT_SIZE * 0.35
  const body: string[] = []

  frame.lines.slice(0, rows).forEach((line, row) => {
    const y = PAD + row * LINE_H
    let col = 0
    const bgs: string[] = []
    const glyphs: string[] = []
    for (const span of line.spans) {
      if (col >= cols) break
      const fg = colorOf(span.fg, DEFAULT_FG) ?? DEFAULT_FG
      const bg = colorOf(span.bg, undefined)
      const bold = (span.attributes & TextAttributes.BOLD) !== 0
      const dim = (span.attributes & TextAttributes.DIM) !== 0
      const underline = (span.attributes & TextAttributes.UNDERLINE) !== 0
      if (bg !== undefined) bgs.push(`<rect x="${PAD + col * PITCH}" y="${y}" width="${span.width * PITCH}" height="${LINE_H}" fill="${bg}"/>`)
      let at = 0
      for (const ch of span.text) {
        if (col + at >= cols) break
        const x = PAD + (col + at) * PITCH
        const rect = blockRects(ch, x, y, fg)
        if (rect !== null) {
          glyphs.push(rect)
        } else if (ch !== " ") {
          const attrs = `font-family="${FONT_STACK}" font-size="${FONT_SIZE}"${bold ? ' font-weight="bold"' : ""}${underline ? ' text-decoration="underline"' : ""}`
          const opacity = dim ? ' opacity="0.6"' : ""
          glyphs.push(`<text x="${x}" y="${baseline + row * LINE_H}" ${attrs} fill="${fg}"${opacity}>${escapeXml(ch)}</text>`)
        }
        at += charCols(ch)
      }
      col += span.width
    }
    body.push(...bgs, ...glyphs)
  })

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${BACKDROP}"/>`,
    ...body,
    `<text x="${PAD}" y="${height - PAD + 2}" font-family="${FONT_STACK}" font-size="11" fill="${CAPTION_FG}">${escapeXml(`opencode-context-doctor · offscreen demo render (synthetic fixtures, not real session data) · ${caption}`)}</text>`,
    `</svg>`,
  ].join("\n")
}

// --- main ------------------------------------------------------------------------

function findConverter(): { cmd: string; args: (svg: string, png: string) => string[] } | undefined {
  const has = (cmd: string) => spawnSync("command", ["-v", cmd], { shell: "/bin/sh", stdio: "ignore" }).status === 0
  if (has("rsvg-convert")) return { cmd: "rsvg-convert", args: (svg, png) => ["-o", png, svg] }
  if (has("magick")) return { cmd: "magick", args: (svg, png) => [svg, png] }
  if (has("convert")) return { cmd: "convert", args: (svg, png) => [svg, png] }
  return undefined
}

export async function main(outDir: string = OUT_DIR): Promise<void> {
  const converter = findConverter()
  if (!converter) {
    console.error("No SVG rasterizer found: install librsvg (rsvg-convert) or ImageMagick (magick/convert).")
    process.exit(1)
  }

  mkdirSync(outDir, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), "context-doctor-shots-"))
  try {
    for (const shot of SHOTS) {
      const frame = await captureFrame(shot)
      const svgPath = join(tmp, `${shot.name}.svg`)
      const pngPath = join(outDir, `${shot.name}.png`)
      writeFileSync(svgPath, frameToSvg(frame, shot.caption))
      const result = spawnSync(converter.cmd, converter.args(svgPath, pngPath), { stdio: ["ignore", "inherit", "inherit"] })
      if (result.status !== 0) {
        console.error(`rasterizing ${shot.name} failed (exit ${result.status})`)
        process.exit(1)
      }
      console.log(`wrote ${pngPath}`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (import.meta.main) await main(process.argv[2])
