import test from "node:test"
import assert from "node:assert/strict"
import {
  ALL_SESSIONS_TABS,
  SESSION_TABS,
  allSessionsDetails,
  allSessionsKpis,
  allSessionsSessionsTable,
  allSessionsToolTables,
  barCells,
  buildTable,
  categoriesTable,
  compositionBlock,
  dominantConsumerInsight,
  elideEnd,
  elideMiddle,
  formatHuman,
  historyModel,
  kpiGrid,
  layoutFor,
  perModelTable,
  rolesTable,
  sessionDetails,
  sessionDialogPlan,
  sessionKpis,
  sessionUsageModel,
  tableLines,
  tabBarRows,
  footerHint,
  toolIOTable,
  toolSchemaTable,
  topSchemaToolInsight,
  wrapProse,
  type TableModel,
} from "./dashboard.ts"
import { formatTokens } from "./format.ts"
import { fixtureReport, fixtureStats, RAW_SECRET } from "./fixtures.ts"

// ---------------------------------------------------------------------------
// Layout & responsive fitting
// ---------------------------------------------------------------------------

test("layout tiers adapt bar width, kpi columns, and clamp content width", () => {
  const narrow = layoutFor(40)
  assert.equal(narrow.tier, "narrow")
  assert.equal(narrow.contentWidth, 34) // floor clamp
  assert.equal(narrow.barWidth, 7)
  assert.equal(narrow.kpiColumns, 2)

  const medium = layoutFor(70)
  assert.equal(medium.tier, "medium")
  assert.equal(medium.contentWidth, 58)
  assert.equal(medium.barWidth, 10)
  assert.equal(medium.kpiColumns, 4)

  const wide = layoutFor(200)
  assert.equal(wide.tier, "wide")
  assert.equal(wide.contentWidth, 108) // ceiling clamp
  assert.equal(wide.barWidth, 14)

  // Degrades safely for degenerate input.
  assert.equal(layoutFor(Number.NaN).contentWidth, 68) // default 80 - 12
})

const WIDTHS = [40, 52, 64, 76, 88, 100, 120, 160, 200]

function assertTableFits(name: string, table: TableModel, contentWidth: number) {
  assert.ok(
    table.width <= contentWidth,
    `${name} overflows: width ${table.width} > content ${contentWidth}`,
  )
  for (const line of tableLines(table)) {
    assert.ok(
      line.length <= contentWidth,
      `${name} row overflows (${line.length} > ${contentWidth}): ${line}`,
    )
  }
}

test("every session table fits its content width across responsive widths", () => {
  const report = fixtureReport()
  for (const width of WIDTHS) {
    const layout = layoutFor(width)
    assertTableFits("schema", toolSchemaTable(report, layout), layout.contentWidth)
    assertTableFits("io", toolIOTable(report, layout), layout.contentWidth)
    assertTableFits("categories", categoriesTable(report, layout), layout.contentWidth)
    assertTableFits("roles", rolesTable(report, layout), layout.contentWidth)
    assertTableFits("history", historyModel(report, layout, undefined).table, layout.contentWidth)
    for (const block of sessionDetails(report, layout)) {
      for (const line of block.lines) {
        assert.ok(line.length <= layout.contentWidth, `details line overflows (${line.length} > ${layout.contentWidth}): ${line}`)
      }
    }
  }
})

test("every all-sessions table fits its content width across responsive widths", () => {
  const stats = fixtureStats()
  for (const width of WIDTHS) {
    const layout = layoutFor(width)
    assertTableFits("per-model", perModelTable(stats, layout), layout.contentWidth)
    assertTableFits("sessions", allSessionsSessionsTable(stats, layout), layout.contentWidth)
    const tools = allSessionsToolTables(stats, layout)
    assertTableFits("global schema", tools.schema, layout.contentWidth)
    assertTableFits("global io", tools.io, layout.contentWidth)
    for (const block of allSessionsDetails(stats, layout)) {
      for (const line of block.lines) {
        assert.ok(line.length <= layout.contentWidth, `details line overflows (${line.length} > ${layout.contentWidth}): ${line}`)
      }
    }
  }
})

test("kpi grid elides to cell width and never exceeds the content width", () => {
  const report = fixtureReport()
  for (const width of WIDTHS) {
    const layout = layoutFor(width)
    const grid = kpiGrid(sessionKpis(report), layout)
    assert.ok(grid.cellWidth >= 12)
    for (const row of grid.rows) {
      assert.ok(row.length <= layout.kpiColumns)
      for (const kpi of row) {
        assert.ok(kpi.value.length <= grid.cellWidth, `value overflows cell: ${kpi.value}`)
        assert.ok(kpi.label.length <= grid.cellWidth, `label overflows cell: ${kpi.label}`)
        assert.ok(kpi.sub === undefined || kpi.sub.length <= grid.cellWidth)
      }
    }
  }
})

test("composition bar rows fit the content width", () => {
  const report = fixtureReport()
  for (const width of WIDTHS) {
    const layout = layoutFor(width)
    const block = compositionBlock(report, layout)
    for (const row of block.rows) {
      // Mirrors BarRows: label + 2, bar cells, " value ", percent, optional "  note".
      const rendered = `${row.label}  ` + "█".repeat(layout.barWidth) + ` ${row.value} ${row.percent}` + (row.note === "" ? "" : `  ${row.note}`)
      assert.ok(rendered.length <= layout.contentWidth, `composition row overflows (${rendered.length} > ${layout.contentWidth}): ${rendered}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Exact math
// ---------------------------------------------------------------------------

test("composition shares use the estimated input total as denominator, exactly", () => {
  const report = fixtureReport()
  const total = report.totals.estimatedInputTokens
  assert.ok(total > 0)
  const block = compositionBlock(report, layoutFor(100))
  const expected = [
    report.totals.systemTokens / total,
    report.totals.messageTokens / total,
    report.totals.toolTokens / total,
  ]
  block.rows.forEach((row, index) => {
    const share = expected[index]!
    assert.equal(row.percent.trim(), `${(share * 100).toFixed(1)}%`)
    assert.equal(row.bar.filled + row.bar.empty, 14) // wide bar width
    assert.equal(row.bar.filled, Math.round(Math.min(1, Math.max(0, share)) * 14))
  })
  assert.equal(block.totalText, formatTokens(total))
  // The three sections are the whole total: shares sum to 1.
  const sum = expected.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9)
})

test("dominant consumer names the real winner with the total as denominator", () => {
  const report = fixtureReport()
  const total = report.totals.estimatedInputTokens
  const winner = [
    ["system prompt", report.totals.systemTokens],
    ["messages", report.totals.messageTokens],
    ["tool schemas", report.totals.toolTokens],
  ].reduce((a, b) => (b[1] > a[1] ? b : a))
  const insight = dominantConsumerInsight(report)!
  assert.ok(insight)
  assert.equal(insight.text.includes(winner[0] as string), true)
  assert.ok(insight.text.includes(((winner[1] as number) / total * 100).toFixed(1)))
  assert.ok(insight.text.includes(formatTokens(winner[1] as number)))
  assert.ok(insight.text.includes(formatTokens(total)))

  // Zero total -> no insight, no division by zero.
  const empty = { ...report, totals: { ...report.totals, estimatedInputTokens: 0 } }
  assert.equal(dominantConsumerInsight(empty as never), undefined)
})

test("top schema tool uses the tool-schema subtotal as denominator", () => {
  const report = fixtureReport()
  const insight = topSchemaToolInsight(report)!
  const top = report.tools.ranked[0]!
  assert.ok(insight.text.includes(top.id))
  assert.ok(insight.text.includes(formatTokens(report.tools.estimatedTokens)))
  assert.ok(insight.text.includes(((top.estimatedTokens / report.tools.estimatedTokens) * 100).toFixed(1)))
})

test("bar cells clamp ratios and fill completely at 100%", () => {
  assert.deepEqual(barCells(0, 10), { filled: 0, empty: 10 })
  assert.deepEqual(barCells(1, 10), { filled: 10, empty: 0 })
  assert.deepEqual(barCells(2, 10), { filled: 10, empty: 0 }) // clamped high
  assert.deepEqual(barCells(-1, 10), { filled: 0, empty: 10 }) // clamped low
  assert.deepEqual(barCells(undefined, 8), { filled: 0, empty: 8 })
  assert.deepEqual(barCells(0.5, 7), { filled: 4, empty: 3 }) // rounds half up
})

test("human formatting stays readable and exact below 10k", () => {
  assert.equal(formatHuman(9_421), "9,421")
  assert.equal(formatHuman(12_412), "12.4k")
  assert.equal(formatHuman(123_456), "123k")
  assert.equal(formatHuman(1_234_567), "1.2M")
})

// ---------------------------------------------------------------------------
// KPIs, utilization, usage honesty
// ---------------------------------------------------------------------------

test("session kpis carry exact totals and the registry-window utilization", () => {
  const report = fixtureReport()
  const kpis = sessionKpis(report)
  assert.equal(kpis.length, 4)
  assert.equal(kpis[0]!.value, formatHuman(report.totals.estimatedInputTokens))
  assert.equal(kpis[0]!.sub, `${formatTokens(report.totals.estimatedInputTokens)} tok`)
  assert.equal(kpis[0]!.estimate, true)
  assert.equal(kpis[1]!.value, `${report.reported.utilizationEstimatedPct!.toFixed(1)}%`)
  assert.ok(kpis[1]!.sub!.includes(formatHuman(report.reported.contextWindowTokens!)))
  assert.equal(kpis[2]!.value, String(report.messages.total))
  assert.ok(kpis[3]!.value.includes(report.model.id))
})

test("all-sessions kpis never surface a summed estimate (no fake lifetime totals)", () => {
  const kpis = allSessionsKpis(fixtureStats())
  const allText = kpis.map(kpi => `${kpi.label} ${kpi.value} ${kpi.sub ?? ""}`).join(" ")
  assert.ok(!allText.includes("sum"))
  assert.equal(kpis[0]!.value, "3") // session count
  assert.equal(kpis[1]!.value, formatHuman(120_000)) // avg latest
  assert.equal(kpis[2]!.value, formatHuman(200_000)) // peak latest
  // The wire type's sumLatest... field must not leak into any KPI.
  const stats = fixtureStats()
  assert.ok(stats.context.perModel[0]!.sumLatestEstimatedInputTokens > 0) // field exists on payload
  for (const kpi of kpis) assert.ok(!kpi.value.includes("36"))
})

test("usage model separates provider counts from estimates and labels the window bar", () => {
  const report = fixtureReport()
  const usage = sessionUsageModel(report, layoutFor(100))
  assert.equal(usage.available, true)
  assert.equal(usage.kpis.length, 4)
  assert.equal(usage.kpis[0]!.label, "input")
  assert.equal(usage.kpis[0]!.value, formatHuman(report.reported.cumulative!.tokens.input))
  assert.ok(usage.utilization)
  assert.equal(usage.utilization!.percent, `${report.reported.utilizationEstimatedPct!.toFixed(1)}%`)
  assert.ok(usage.utilization!.value.includes("200k"))
})

// ---------------------------------------------------------------------------
// Tabs, arguments, history
// ---------------------------------------------------------------------------

test("tab sets are stable and digit-keyed", () => {
  assert.deepEqual(SESSION_TABS.map(tab => tab.id), ["overview", "tools", "history", "usage", "details"])
  assert.deepEqual(ALL_SESSIONS_TABS.map(tab => tab.id), ["overview", "tools", "sessions", "usage", "details"])
  assert.deepEqual(SESSION_TABS.map(tab => tab.bind), ["1", "2", "3", "4", "5"])
})

test("tab bar rows adapt to the layout tier without wrapping", () => {
  const wide = tabBarRows(SESSION_TABS, "tools", layoutFor(120))
  assert.equal(wide.length, 1)
  assert.equal(wide[0]!.length, 5)
  const wideRowWidth = wide[0]!.reduce((sum, tab, i) => sum + tab.text.length + (tab.active ? 1 : 1) + (i > 0 ? 2 : 0), 0)
  assert.ok(wideRowWidth <= layoutFor(120).contentWidth)
  assert.deepEqual(wide[0]!.map(tab => tab.active), [false, true, false, false, false])

  const narrow = tabBarRows(SESSION_TABS, "history", layoutFor(46))
  assert.equal(narrow.length, 2, "narrow bars use a digit row plus the active title")
  assert.deepEqual(narrow[0]!.map(tab => tab.text), ["1", "2", "3", "4", "5"])
  assert.deepEqual(narrow[0]!.map(tab => tab.marker), [true, true, true, true, true])
  assert.equal(narrow[1]![0]!.text, "History")
  assert.equal(narrow[1]![0]!.marker, false, "title row must not repeat the active marker")
})

test("footer hints fit every layout tier", () => {
  for (const width of WIDTHS) {
    const layout = layoutFor(width)
    assert.ok(footerHint(layout).length <= layout.contentWidth, `footer overflows at ${width}`)
  }
  assert.ok(footerHint(layoutFor(46)).length < footerHint(layoutFor(120)).length)
})

test("dialog plans map legacy arguments onto tabs", () => {
  assert.deepEqual(sessionDialogPlan({}), { scope: "session", tabs: SESSION_TABS, initialTabId: "overview", lastN: undefined })
  assert.deepEqual(sessionDialogPlan({ mode: "tools" }), { scope: "session", tabs: SESSION_TABS, initialTabId: "tools", lastN: undefined })
  assert.deepEqual(sessionDialogPlan({ mode: "short", lastN: 7 }), { scope: "session", tabs: SESSION_TABS, initialTabId: "overview", lastN: 7 })
})

test("history model honors lastN and reports both counts", () => {
  const report = fixtureReport()
  const many = {
    ...report,
    history: Array.from({ length: 20 }, (_, i) => ({ ...report.history[0]!, capturedAt: 1_000 + i })),
  }
  const model = historyModel(many, layoutFor(100), 3)
  assert.equal(model.points, 3)
  assert.equal(model.totalPoints, 20)
  assert.equal(model.table.rows.length, 3)
  const unbounded = historyModel(many, layoutFor(100), undefined)
  assert.equal(unbounded.points, 20)
})

// ---------------------------------------------------------------------------
// Elision & wrapping
// ---------------------------------------------------------------------------

test("elide middle keeps head and tail of identifiers", () => {
  assert.equal(elideMiddle("ses_short", 20), "ses_short")
  assert.equal(elideMiddle("ses_abcdefghijk", 10), "ses_abc…jk")
  assert.equal(elideMiddle("x", 1), "x")
  assert.ok(elideMiddle("ses_abcdefghijk", 10).length <= 10)
})

test("elide end truncates with an ellipsis and never exceeds max", () => {
  assert.equal(elideEnd("short", 10), "short")
  assert.equal(elideEnd("a-very-long-tool-name", 8), "a-very-…")
  assert.equal(elideEnd("tool", 1), "t")
  for (const value of ["", "x", "0123456789abcdef"]) {
    assert.ok(elideEnd(value, 5).length <= 5)
  }
})

test("wrapProse wraps on word boundaries within the width", () => {
  const text = "Estimates are local character-ratio heuristics and never a model tokenizer; provider counts are separate."
  const lines = wrapProse(text, 30)
  assert.ok(lines.length > 1)
  for (const line of lines) assert.ok(line.length <= 30, `wrapped line too long: "${line}"`)
  assert.equal(lines.join(" ").replace(/\s+/g, " ").trim(), text)
  // Unbreakable tokens are elided, not overflowed.
  const [only] = wrapProse("abcdefghij", 5)
  assert.ok(only!.length <= 5)
})

// ---------------------------------------------------------------------------
// Table internals & privacy
// ---------------------------------------------------------------------------

test("buildTable shrinks the flexible column and keeps fixed columns intact", () => {
  const layout = layoutFor(48) // content 36
  const table = buildTable(
    [
      { title: "tool", align: "left", min: 4, elide: "middle" },
      { title: "tok (est)", align: "right", shrinkable: false },
      { title: "% tools", align: "right", shrinkable: false },
    ],
    [
      [
        { text: "github_create_issue_with_a_long_name" },
        { text: "1,234,567" },
        { text: "100.0%" },
      ],
    ],
    layout,
  )
  assert.ok(table.width <= layout.contentWidth)
  const row = table.rows[0]!.cells.map(cell => cell.padded).join("  ")
  assert.ok(row.length <= layout.contentWidth)
  // Fixed numeric columns keep their full content.
  assert.ok(row.includes("1,234,567"))
  assert.ok(row.includes("100.0%"))
  // The flexible column was elided.
  assert.ok(!row.includes("github_create_issue_with_a_long_name"))
})

test("no view-model string leaks raw content secrets", () => {
  const report = fixtureReport()
  const stats = fixtureStats()
  const layout = layoutFor(100)
  const dumps = [
    JSON.stringify(sessionKpis(report)),
    JSON.stringify(allSessionsKpis(stats)),
    JSON.stringify(compositionBlock(report, layout)),
    JSON.stringify(categoriesTable(report, layout)),
    JSON.stringify(toolSchemaTable(report, layout)),
    JSON.stringify(toolIOTable(report, layout)),
    JSON.stringify(sessionUsageModel(report, layout)),
    JSON.stringify(sessionDetails(report, layout)),
    JSON.stringify(allSessionsDetails(stats, layout)),
    JSON.stringify(historyModel(report, layout, undefined)),
  ].join("\n")
  assert.ok(!dumps.includes(RAW_SECRET), "raw fixture secret leaked into the view model")
  assert.ok(!dumps.includes("NaN"))
  assert.ok(!dumps.includes("undefined"))
})
