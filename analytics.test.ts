import test from "node:test"
import assert from "node:assert/strict"
import { analyzeContextEvent, groupForToolID, type ContextEventLike } from "./analytics.ts"
import { estimateJsonTokens, estimateTextTokens } from "./estimate.ts"
import { RAW_SECRET, fixtureAnalysis, fixtureEvent } from "./fixtures.ts"

const NOW = 1_700_000_000_000

test("system section estimates every text part and counts cache hints", () => {
  const analysis = fixtureAnalysis()
  const expected = estimateTextTokens("You are a coding agent. Follow AGENTS.md instructions.") + estimateTextTokens("Tool catalog preamble follows.")
  assert.equal(analysis.system.estimatedTokens, expected)
  assert.equal(analysis.system.parts, 2)
  assert.equal(analysis.system.cacheHintedParts, 1)
})

test("system provenance is always labeled unavailable, even when freeform metadata exists", () => {
  const analysis = fixtureAnalysis() // fixture includes metadata.source on a part
  assert.equal(analysis.system.provenance.available, false)
  assert.deepEqual(analysis.system.provenance.sources, [])
  assert.match(analysis.system.provenance.note, /unattributed/i)
})

test("roles and part types are aggregated with correct part counts from the first insert", () => {
  const analysis = fixtureAnalysis()
  const roles = Object.fromEntries(analysis.messages.byRole.map(entry => [entry.role, entry]))
  assert.equal(roles.user.messages, 1)
  assert.equal(roles.assistant.messages, 2)
  assert.equal(roles.tool.messages, 1)
  assert.equal(roles.user.parts, 2) // text + media
  const partTypes = Object.fromEntries(analysis.messages.byPartType.map(entry => [entry.partType, entry]))
  assert.equal(partTypes.text.parts, 3) // user text + 2 assistant texts: first insert counts as 1
  assert.equal(partTypes["tool-call"].parts, 1)
  assert.equal(partTypes["tool-result"].parts, 1)
  assert.equal(partTypes.media.parts, 1)
  assert.equal(partTypes.media.countedOnly, true)
  assert.equal(partTypes.media.estimatedTokens, 0)
  // No NaN anywhere in the aggregated buckets.
  for (const entry of analysis.messages.byPartType) {
    assert.ok(Number.isFinite(entry.parts), `parts not finite for ${entry.partType}`)
    assert.ok(Number.isFinite(entry.estimatedTokens))
    assert.ok(Number.isFinite(entry.characters))
  }
})

test("serialized sizes are exact: quotes, backslashes, and payloads beyond 20k are not re-escaped or clamped", () => {
  const tricky = { code: 'he said "hi" \\ back\\slash', path: "a/b" }
  const event = fixtureEvent({
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool-call", id: "c1", name: "bash", input: tricky }],
      } as never,
    ],
    tools: {},
  })
  const analysis = analyzeContextEvent(event, { now: () => 1 })
  const call = analysis.messages.byPartType.find(entry => entry.partType === "tool-call")
  assert.ok(call)
  assert.equal(call.characters, "bash".length + JSON.stringify(tricky).length)

  const big = { blob: "x".repeat(25_000) }
  const bigEvent = fixtureEvent({
    messages: [
      { role: "tool", content: [{ type: "tool-result", id: "c2", name: "read", result: { type: "text", value: big } }] } as never,
    ],
    tools: {},
  })
  const bigAnalysis = analyzeContextEvent(bigEvent, { now: () => 1 })
  const resultPart = bigAnalysis.messages.byPartType.find(entry => entry.partType === "tool-result")
  assert.ok(resultPart)
  assert.equal(resultPart.characters, "read".length + JSON.stringify(big).length)
  assert.ok(resultPart.characters > 25_000)

  // Tool schema character accounting uses the same exact serialization.
  const schemaEvent = fixtureEvent({ messages: [], tools: { t: { description: "d", input: tricky } } })
  const schemaAnalysis = analyzeContextEvent(schemaEvent, { now: () => 1 })
  assert.equal(schemaAnalysis.tools.ranked[0]!.schemaCharacters, JSON.stringify(tricky).length)
})

test("categories split user text, assistant text, reasoning, and tool io", () => {
  const analysis = fixtureAnalysis()
  const categories = Object.fromEntries(analysis.messages.categories.map(entry => [entry.category, entry]))
  assert.ok((categories["user-text"].parts ?? 0) >= 1)
  assert.ok((categories["assistant-text"].parts ?? 0) >= 2)
  assert.equal(categories["reasoning"].parts, 1)
  assert.equal(categories["tool-io"].parts, 2)
  const sum = analysis.messages.categories.reduce((total, entry) => total + entry.estimatedTokens, 0)
  assert.equal(sum, analysis.totals.messageTokens)
})

test("encrypted compaction payloads are counted, never estimated", () => {
  const event = fixtureEvent({
    messages: [
      {
        role: "assistant",
        content: [{ type: "compaction", provider: "anthropic", encrypted: "opaque-payload-123456" }],
      } as never,
    ],
  })
  const analysis = analyzeContextEvent(event, { now: () => NOW })
  const compaction = analysis.messages.byPartType.find(entry => entry.partType === "compaction")
  assert.ok(compaction)
  assert.equal(compaction.countedOnly, true)
  assert.equal(compaction.estimatedTokens, 0)
  assert.equal(compaction.characters, "opaque-payload-123456".length)
})

test("unrecognized part shapes degrade to a counted-only other bucket", () => {
  const event = fixtureEvent({
    messages: [{ role: "user", content: [{ type: "hologram", data: 1 } as never] } as never],
  })
  const analysis = analyzeContextEvent(event, { now: () => NOW })
  const other = analysis.messages.byPartType.find(entry => entry.partType === "hologram")
  assert.ok(other)
  assert.equal(other.countedOnly, true)
})

test("tool schema ranking comes from the request snapshot, sorted descending", () => {
  const analysis = fixtureAnalysis()
  assert.equal(analysis.tools.source, "context-hook-request-snapshot")
  assert.equal(analysis.tools.total, 3)
  const tokens = analysis.tools.ranked.map(tool => tool.estimatedTokens)
  assert.deepEqual([...tokens].sort((a, b) => b - a), tokens)
})

test("Code Mode accounting: catalog text in messages stays out of the tools total", () => {
  // A large instructions-like message plus a tiny tools map. If schema text
  // were double-counted or misattributed, toolTokens would absorb it.
  const catalogText = "tool catalog reference: read(path), bash(command), github_create_issue(owner, repo, title, body). ".repeat(200)
  const event = fixtureEvent({
    messages: [{ role: "user", content: [{ type: "text", text: catalogText }] } as never],
    tools: { read: { description: "Read a file.", input: { type: "object", properties: { path: { type: "string" } } } } },
  })
  const analysis = analyzeContextEvent(event, { now: () => NOW })
  const messageText = analysis.messages.byPartType.find(entry => entry.partType === "text")
  assert.ok(messageText)
  // The whole catalog text lands in the messages bucket (exact expectation, no threshold).
  assert.equal(messageText.estimatedTokens, estimateTextTokens(catalogText))
  assert.equal(analysis.tools.total, 1)
  // Schema footprint is the single description plus its small schema - nowhere near the catalog text.
  assert.equal(analysis.tools.estimatedTokens, estimateTextTokens("Read a file.") + estimateJsonTokens(event.tools.read!.input))
  assert.ok(analysis.tools.estimatedTokens < messageText.estimatedTokens)
  assert.equal(analysis.totals.estimatedInputTokens, analysis.totals.systemTokens + analysis.totals.messageTokens + analysis.totals.toolTokens)
})

test("mcp grouping is a longest-prefix heuristic; builtin tools stay unattributed", () => {
  assert.deepEqual(groupForToolID("github_create_issue", ["github"]), { kind: "mcp-server", name: "github", attribution: "heuristic-prefix" })
  assert.deepEqual(groupForToolID("read", ["github"]), { kind: "other", name: "other", attribution: "none" })
  assert.deepEqual(groupForToolID("open_session_tabs", ["github"]), { kind: "other", name: "other", attribution: "none" })
  assert.deepEqual(groupForToolID("docs_extra_search", ["docs", "docs_extra"]), { kind: "mcp-server", name: "docs_extra", attribution: "heuristic-prefix" })
  assert.deepEqual(groupForToolID("github", ["github"]), { kind: "mcp-server", name: "github", attribution: "heuristic-prefix" })
})

test("groups reflect the configured server names at analysis time", () => {
  const withServers = fixtureAnalysis({ mcpServers: ["github"] })
  const github = withServers.tools.groups.find(group => group.kind === "mcp-server")
  assert.ok(github)
  assert.equal(github.name, "github")
  assert.equal(github.tools, 1)
  const withoutServers = analyzeContextEvent(fixtureEvent(), { now: () => NOW })
  assert.equal(withoutServers.tools.groups.length, 1)
  assert.equal(withoutServers.tools.groups[0]!.kind, "other")
})

test("per-tool transcript io is ranked separately from the schema footprint", () => {
  const base = fixtureAnalysis()
  // Same schema footprint, more transcript io: schema total must not move.
  const bigger = fixtureAnalysis({
    event: fixtureEvent({
      messages: [
        ...(fixtureEvent().messages as ContextEventLike["messages"]),
        {
          role: "tool",
          content: [
            { type: "tool-result", id: "call_2", name: "bash", result: { type: "text", value: "x".repeat(4_000) } },
          ],
        } as never,
      ],
    }),
  })
  assert.equal(bigger.tools.estimatedTokens, base.tools.estimatedTokens)
  assert.ok(bigger.tools.io.estimatedTokens > base.tools.io.estimatedTokens)
  assert.ok(bigger.tools.io.totalResults > base.tools.io.totalResults)

  const io = base.tools.io
  assert.equal(io.totalCalls, 1)
  assert.equal(io.totalResults, 1)
  const read = io.ranked.find(entry => entry.name === "read")
  assert.ok(read)
  assert.equal(read.calls, 1)
  assert.equal(read.results, 1)
  assert.equal(read.estimatedTokens, read.estimatedCallTokens + read.estimatedResultTokens)
  assert.match(io.note, /subset of the messages total/)
})

test("privacy: analyses store keys and sizes, never raw content", () => {
  const analysis = fixtureAnalysis()
  const serialized = JSON.stringify(analysis)
  assert.ok(!serialized.includes(RAW_SECRET))
  assert.ok(!serialized.includes("Read a file from the local filesystem.")) // tool description text
  assert.ok(!serialized.includes("/etc/app.conf")) // tool input content
  assert.ok(!serialized.includes("Please read the config.")) // message text
  assert.ok(serialized.includes("github_create_issue")) // tool ids (keys) are kept
})

test("analysis is observational: the event object is not mutated", () => {
  const event = fixtureEvent()
  const before = JSON.stringify(event)
  analyzeContextEvent(event, { now: () => NOW })
  assert.equal(JSON.stringify(event), before)
})

test("capturedAt comes from the injected clock and metadata is labeled", () => {
  const analysis = analyzeContextEvent(fixtureEvent(), { now: () => 123_456 })
  assert.equal(analysis.capturedAt, 123_456)
  assert.equal(analysis.estimation.method, "heuristic-local")
  assert.equal(analysis.estimation.remoteCalls, false)
  assert.deepEqual(analysis.scope.kinds, ["primary"])
  assert.ok(analysis.limits.length >= 5)
})
