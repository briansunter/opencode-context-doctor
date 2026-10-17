import test from "node:test"
import assert from "node:assert/strict"
import { buildReported, findContextWindow } from "./enrich.ts"
import { USAGE_NOTES, emptySessionUsage } from "./usage.ts"
import { fixtureModels } from "./fixtures.ts"

test("findContextWindow matches by canonical modelID or effective id", () => {
  assert.equal(findContextWindow(fixtureModels() as never, { providerID: "anthropic", id: "claude-sonnet-4-5" }), 200_000)
  assert.equal(findContextWindow([{ id: "eff", modelID: "canonical", providerID: "p", limit: { context: 1 } }], { providerID: "p", id: "canonical" }), 1)
  assert.equal(findContextWindow(fixtureModels() as never, { providerID: "anthropic", id: "missing" }), undefined)
  assert.equal(findContextWindow([], { providerID: "anthropic", id: "claude-sonnet-4-5" }), undefined)
  assert.equal(
    findContextWindow([{ id: "x", modelID: "x", providerID: "p", limit: { context: 0 } }], { providerID: "p", id: "x" }),
    undefined,
  )
})

function durable() {
  return {
    steps: 2,
    total: { input: 190_000, output: 2_100, reasoning: 400, cacheRead: 165_000, cacheWrite: 7_000 },
    last: {
      tokens: { input: 100_000, output: 900, reasoning: 100, cacheRead: 85_000, cacheWrite: 3_000 },
      createdAt: 1_700_000_200_000,
      model: "anthropic/claude-sonnet-4-5",
    },
  }
}

test("buildReported prefers live cumulative usage and marks it ephemeral", () => {
  const usage = {
    ...emptySessionUsage(),
    live: {
      tokens: { input: 300_000, output: 5_000, reasoning: 100, cacheRead: 50_000, cacheWrite: 9_000 },
      capturedAt: 1_700_000_900_000,
      source: "session.usage.updated" as const,
      ephemeral: true as const,
    },
  }
  const reported = buildReported({ estimatedInputTokens: 120_000, usage, durable: durable(), contextWindowTokens: 200_000, usageNotes: USAGE_NOTES })
  assert.equal(reported.available, true)
  assert.equal(reported.cumulative?.source, "session.usage.updated")
  assert.equal(reported.cumulative?.ephemeral, true)
  assert.equal(reported.cumulative?.tokens.input, 300_000)
  // No reported utilization is computed at all: the latest reply may be from a
  // different model than the snapshot and provider cache accounting differs.
  assert.equal("utilizationReportedPct" in reported, false)
  assert.equal(reported.utilizationEstimatedPct, 60)
  assert.ok(reported.notes.some(note => note.includes("live cumulative total")))
  assert.ok(reported.notes.some(note => note.includes("not single-request context-window occupancy")))
  assert.ok(reported.notes.some(note => note.includes("shown raw without a utilization percentage")))
})

test("buildReported falls back to the durable per-step sum", () => {
  const reported = buildReported({
    estimatedInputTokens: 50_000,
    usage: emptySessionUsage(),
    durable: durable(),
    contextWindowTokens: 200_000,
    usageNotes: USAGE_NOTES,
  })
  assert.equal(reported.available, true)
  assert.equal(reported.cumulative?.source, "session.context-sum")
  assert.equal(reported.cumulative?.ephemeral, false)
  assert.equal(reported.cumulative?.tokens.input, 190_000)
  assert.equal(reported.durableSteps, 2)
  assert.equal(reported.lastStep?.model, "anthropic/claude-sonnet-4-5")
  // Last-step tokens are shown raw; no reported utilization is derived from them.
  assert.equal("utilizationReportedPct" in reported, false)
  assert.ok(reported.notes.some(note => note.includes("durable per-step sum")))
})

test("buildReported degrades cleanly with nothing available", () => {
  const reported = buildReported({
    estimatedInputTokens: 50_000,
    usage: emptySessionUsage(),
    durable: { steps: 0, total: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
    contextWindowTokens: undefined,
    usageNotes: USAGE_NOTES,
  })
  assert.equal(reported.available, false)
  assert.equal(reported.cumulative, undefined)
  assert.equal(reported.utilizationEstimatedPct, undefined)
  assert.equal(reported.contextWindowSource, "none")
  assert.ok(reported.notes.some(note => note.includes("Context-window limit unavailable")))
})

test("auxiliary records ride along without joining the totals", () => {
  const usage = {
    live: {
      tokens: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      capturedAt: 2_000,
      source: "session.usage.updated" as const,
      ephemeral: true as const,
    },
    auxiliary: [{ source: "title", capturedAt: 1_000, tokens: { input: 999, output: 99, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
  }
  const reported = buildReported({ estimatedInputTokens: 10, usage, durable: durable(), contextWindowTokens: 1_000, usageNotes: USAGE_NOTES })
  assert.equal(reported.cumulative?.tokens.input, 10)
  assert.equal(reported.auxiliary?.[0]?.source, "title")
  assert.equal(reported.auxiliary?.[0]?.tokens.input, 999)
})
