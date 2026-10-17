import test from "node:test"
import assert from "node:assert/strict"
import {
  formatBar,
  formatCompact,
  formatPercent,
  formatReportLines,
  formatSessionSummaryLine,
  formatTimestamp,
  formatTokens,
  isHeadingLine,
  parseReportArgs,
} from "./format.ts"
import { fixtureReport } from "./fixtures.ts"

test("number formatting is deterministic", () => {
  assert.equal(formatTokens(0), "0")
  assert.equal(formatTokens(999), "999")
  assert.equal(formatTokens(1234567), "1,234,567")
  assert.equal(formatCompact(250_000), "250k")
  assert.equal(formatCompact(999), "999")
  assert.equal(formatPercent(0.36633), "36.6%")
  assert.equal(formatPercent(undefined), "n/a")
  assert.equal(formatTimestamp(1_700_000_000_000), "2023-11-14 22:13:20Z")
})

test("ascii bars render ratios in compact form", () => {
  assert.equal(formatBar(1), "##########")
  assert.equal(formatBar(0), "..........")
  assert.equal(formatBar(0.5, 4), "##..")
  assert.equal(formatBar(undefined), "..........")
  assert.equal(formatBar(2), "##########") // clamped
})

test("parseReportArgs extracts mode and lastN, ignoring junk", () => {
  assert.deepEqual(parseReportArgs(undefined), {})
  assert.deepEqual(parseReportArgs(""), {})
  assert.deepEqual(parseReportArgs("short"), { mode: "short" })
  assert.deepEqual(parseReportArgs("tools 5"), { mode: "tools", lastN: 5 })
  assert.deepEqual(parseReportArgs("7"), { lastN: 7 })
  assert.deepEqual(parseReportArgs("detailed banana 0"), { mode: "detailed" }) // 0 invalid, junk ignored
  assert.deepEqual(parseReportArgs("short tools"), { mode: "tools" }) // last mode wins
})

test("detailed mode renders every section", () => {
  const lines = formatReportLines(fixtureReport())
  const text = lines.join("\n")
  for (const section of [
    "ESTIMATED INPUT",
    "SYSTEM PROMPT",
    "MESSAGE CATEGORIES",
    "MESSAGES BY ROLE",
    "MESSAGES BY PART TYPE",
    "TOOL SCHEMAS",
    "TOOL I/O IN TRANSCRIPT",
    "REPORTED USAGE",
    "RETENTION & ERRORS",
    "LIMITS",
  ]) {
    assert.ok(text.includes(section), `missing section ${section}`)
  }
  assert.ok(text.includes("##########")) // bar chart present
})

test("short mode stays compact with bars, categories, and reported totals", () => {
  const report = fixtureReport()
  const lines = formatReportLines(report, { mode: "short" })
  const text = lines.join("\n")
  assert.ok(text.includes("ESTIMATED INPUT"))
  assert.ok(text.includes("MESSAGE CATEGORIES"))
  assert.ok(text.includes("REPORTED USAGE"))
  assert.ok(!text.includes("MESSAGES BY ROLE"))
  assert.ok(!text.includes("SNAPSHOT HISTORY"))
  assert.ok(lines.length < 30, `short mode should be short, got ${lines.length} lines`)
})

test("tools mode focuses on schema footprint and transcript io", () => {
  const lines = formatReportLines(fixtureReport(), { mode: "tools" })
  const text = lines.join("\n")
  assert.ok(text.includes("TOOL SCHEMAS"))
  assert.ok(text.includes("TOOL I/O IN TRANSCRIPT"))
  assert.ok(text.includes("github_create_issue"))
  assert.ok(text.includes("subset of the messages total"))
  assert.ok(!text.includes("MESSAGES BY ROLE"))
})

test("lastN bounds the history section", () => {
  const report = fixtureReport()
  const many = {
    ...report,
    history: Array.from({ length: 20 }, (_, i) => ({ ...report.history[0]!, capturedAt: 1_000 + i })),
  }
  const text = formatReportLines(many, { lastN: 3 }).join("\n")
  const historyCount = text.split("\n").filter(line => line.match(/^\s{2}\d{2}:\d{2}:\d{2}\s+\d/)).length
  assert.equal(historyCount, 3)
})

test("rendered output never contains NaN, undefined, or raw markers", () => {
  const report = fixtureReport()
  for (const options of [{}, { mode: "short" as const }, { mode: "tools" as const }, { mode: "detailed" as const, lastN: 2 }]) {
    const text = formatReportLines(report, options).join("\n")
    assert.ok(!text.includes("NaN"), `NaN leaked in ${JSON.stringify(options)}`)
    assert.ok(!text.includes("undefined"), `undefined leaked in ${JSON.stringify(options)}`)
    assert.ok(!text.includes("SECRET-RAW-CONTENT"), `raw content leaked in ${JSON.stringify(options)}`)
  }
})

test("session summary lines are single-line and informative", () => {
  const report = fixtureReport()
  const line = formatSessionSummaryLine({
    sessionID: "ses_x",
    agent: "build",
    model: report.model,
    snapshotCount: 3,
    lastCapturedAt: 1_700_000_000_000,
    lastEstimatedInputTokens: 123_456,
    lastMessageCount: 12,
    hookErrorCount: 1,
    lastActiveAt: 1,
  })
  assert.ok(!line.includes("\n"))
  assert.ok(line.includes("123k")) // compact formatting in summary lines
  assert.ok(line.includes("1 err"))
})

test("heading detection is stable for the renderer", () => {
  assert.equal(isHeadingLine("── LIMITS"), true)
  assert.equal(isHeadingLine("  - some limit"), false)
})
