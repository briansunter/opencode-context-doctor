import test from "node:test"
import assert from "node:assert/strict"
import {
  applyAuxiliary,
  applyCumulative,
  classifyUsageEvent,
  emptySessionUsage,
  maxAuxiliaryRecords,
  parseTokens,
  summarizeDurableUsage,
} from "./usage.ts"
import { locationMatches } from "./location.ts"
import { fixtureSessionMessages } from "./fixtures.ts"

const tokens = { input: 10, output: 2, reasoning: 1, cacheRead: 5, cacheWrite: 3 }

test("parseTokens accepts token-usage shapes and rejects junk", () => {
  assert.deepEqual(parseTokens({ ...tokens, cache: { read: 5, write: 3 } }), tokens)
  assert.equal(parseTokens({ input: "10" }), undefined)
  assert.equal(parseTokens(undefined), undefined)
  assert.equal(parseTokens({ cache: { read: 1 } }), undefined)
  // Missing fields coerce to 0 rather than failing the whole record.
  assert.deepEqual(parseTokens({ input: 7, cache: {} }), { input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
})

test("cumulative usage events replace, never sum", () => {
  let usage = emptySessionUsage()
  usage = applyCumulative(usage, { ...tokens, input: 100 }, 1_000)
  usage = applyCumulative(usage, { ...tokens, input: 150 }, 2_000)
  assert.equal(usage.live?.tokens.input, 150)
  // A late-arriving older event must not overwrite a newer total.
  usage = applyCumulative(usage, { ...tokens, input: 120 }, 1_500)
  assert.equal(usage.live?.tokens.input, 150)
  assert.equal(usage.live?.source, "session.usage.updated")
  assert.equal(usage.live?.ephemeral, true)
})

test("auxiliary usage records are bounded and kept separately", () => {
  let usage = emptySessionUsage()
  for (let i = 0; i < maxAuxiliaryRecords + 5; i++) {
    usage = applyAuxiliary(usage, "title", { ...tokens, input: i }, i)
  }
  assert.equal(usage.auxiliary.length, maxAuxiliaryRecords)
  assert.equal(usage.live, undefined)
})

test("classifyUsageEvent separates cumulative, auxiliary, and everything else", () => {
  const cumulative = classifyUsageEvent({ type: "session.usage.updated", created: 5, data: { sessionID: "s1", tokens: { ...tokens, cache: { read: 5, write: 3 } } } })
  assert.equal(cumulative.kind, "cumulative")
  assert.equal(cumulative.sessionID, "s1")

  const auxiliary = classifyUsageEvent({ type: "session.usage.recorded", created: 6, data: { sessionID: "s1", source: "compaction", tokens: { ...tokens, cache: { read: 5, write: 3 } } } })
  assert.equal(auxiliary.kind, "auxiliary")
  assert.equal(auxiliary.source, "compaction")

  assert.equal(classifyUsageEvent({ type: "session.text.delta", created: 7, data: { delta: "x" } }).kind, "ignored")
  assert.equal(classifyUsageEvent({ type: "session.usage.updated", created: 7, data: {} }).kind, "ignored")
  assert.equal(classifyUsageEvent({ type: "session.usage.updated", created: 7, data: { tokens: { ...tokens, cache: {} } } }).kind, "ignored")
})

test("durable summary sums per-step assistant records and finds the latest", () => {
  const summary = summarizeDurableUsage(fixtureSessionMessages(), message => {
    const m = message as { type?: string; tokens?: unknown; time?: { created?: number }; model?: { providerID?: string; id?: string } }
    if (m.type !== "assistant") return undefined
    return { tokens: m.tokens, createdAt: m.time?.created, model: m.model ? `${m.model.providerID}/${m.model.id}` : "" }
  })
  assert.equal(summary.steps, 2)
  assert.equal(summary.total.input, 190_000)
  assert.equal(summary.total.cacheRead, 165_000)
  assert.equal(summary.last?.model, "anthropic/claude-sonnet-4-5")
  assert.equal(summary.last?.createdAt, 1_700_000_200_000)
})

test("durable summary tolerates malformed entries", () => {
  const summary = summarizeDurableUsage([null, 7, { type: "assistant", tokens: "nope" }, { type: "assistant", tokens: { input: 1, cache: {} } }], message => message as never)
  assert.equal(summary.steps, 1)
  assert.equal(summary.total.input, 1)
})

test("locationMatches enforces strict same-location filtering", () => {
  const plugin = { directory: "/work/project" }
  assert.equal(locationMatches({ directory: "/work/project" }, plugin), true)
  assert.equal(locationMatches({ directory: "/other/project" }, plugin), false)
  assert.equal(locationMatches(undefined, plugin), false) // unverifiable -> fail closed
  assert.equal(locationMatches({ directory: "/work/project", workspaceID: "w2" }, { ...plugin, workspaceID: "w1" }), false)
  assert.equal(locationMatches({ directory: "/work/project", workspaceID: "w1" }, { ...plugin, workspaceID: "w1" }), true)
  assert.equal(locationMatches({ directory: "/work/project" }, { ...plugin, workspaceID: "w1" }), true) // event without workspace cannot conflict
})
