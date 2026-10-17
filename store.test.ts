import test from "node:test"
import assert from "node:assert/strict"
import { analysisSignature, createSnapshotStore, stableStringify } from "./store.ts"
import { fixtureAnalysis } from "./fixtures.ts"

function analysisWith(overrides: { tokens?: number; sessionID?: string; at: number }) {
  const base = fixtureAnalysis()
  return {
    ...base,
    sessionID: overrides.sessionID ?? base.sessionID,
    capturedAt: overrides.at,
    totals: { ...base.totals, estimatedInputTokens: overrides.tokens ?? base.totals.estimatedInputTokens },
  }
}

test("record stores snapshots and dedupes unchanged re-observations", () => {
  const store = createSnapshotStore({ now: () => 1_000 })
  assert.deepEqual(store.record(analysisWith({ at: 1_000 })), { stored: true })
  // Identical content at a new timestamp is an unchanged re-observation.
  assert.deepEqual(store.record(analysisWith({ at: 2_000 })), { stored: false, reason: "unchanged" })
  // Changed content stores again.
  assert.deepEqual(store.record(analysisWith({ tokens: 5_000, at: 3_000 })), { stored: true })
  assert.equal(store.get("ses_test")?.snapshots.length, 2)
})

test("snapshot history is bounded, keeping the newest", () => {
  const store = createSnapshotStore({ maxSnapshotsPerSession: 3, now: () => 0 })
  for (let i = 1; i <= 6; i++) {
    store.record(analysisWith({ tokens: i * 1_000, at: i }))
  }
  const entry = store.get("ses_test")
  assert.equal(entry?.snapshots.length, 3)
  assert.deepEqual(entry?.snapshots.map(s => s.totals.estimatedInputTokens % 10_000), [4_000, 5_000, 6_000])
})

test("session capacity evicts least-recently-active sessions", () => {
  const store = createSnapshotStore({ maxSessions: 2, now: () => 0 })
  store.record(analysisWith({ sessionID: "ses_a", tokens: 1, at: 1 }))
  store.record(analysisWith({ sessionID: "ses_b", tokens: 2, at: 2 }))
  store.record(analysisWith({ sessionID: "ses_a", tokens: 3, at: 3 })) // touch a
  store.record(analysisWith({ sessionID: "ses_c", tokens: 4, at: 4 })) // evicts b
  assert.equal(store.get("ses_b"), undefined)
  assert.ok(store.get("ses_a"))
  assert.ok(store.get("ses_c"))
  assert.equal(store.list().length, 2)
})

test("idle sessions are swept on the next write", () => {
  let clock = 0
  const store = createSnapshotStore({ sessionIdleMs: 1_000, now: () => clock })
  store.record(analysisWith({ sessionID: "ses_old", tokens: 1, at: 0 }))
  clock = 5_000
  store.record(analysisWith({ sessionID: "ses_new", tokens: 2, at: 5_000 }))
  assert.equal(store.get("ses_old"), undefined)
  assert.ok(store.get("ses_new"))
})

test("recordError persists first-capture failures even with no prior snapshot", () => {
  const store = createSnapshotStore({ now: () => 0 })
  // First invocation throws before any snapshot exists: the error must not vanish.
  store.recordError("ses_ghost", "analysis-failed")
  const entry = store.get("ses_ghost")
  assert.equal(entry?.errors.count, 1)
  assert.equal(entry?.errors.lastCode, "analysis-failed")
  assert.equal("lastMessage" in (entry?.errors ?? {}), false)
  // Error-only entries stay out of list() (summary fields need a snapshot)...
  assert.equal(store.list().length, 0)
  assert.deepEqual(store.stats(), { sessionsWithSnapshots: 0, sessionsWithErrorOnly: 1 })
  // ...but a later successful capture adopts the entry and keeps the error count.
  store.record(analysisWith({ at: 0 }))
  store.recordError("ses_test", "analysis-failed")
  assert.equal(store.get("ses_test")?.errors.count, 1)
  const listed = store.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.hookErrorCount, 1)
  assert.equal(listed[0]!.snapshotCount, 1)
  // ses_ghost is still tracked as error-only alongside the recovered session.
  assert.deepEqual(store.stats(), { sessionsWithSnapshots: 1, sessionsWithErrorOnly: 1 })
})

test("recordError ignores malformed session ids instead of creating junk entries", () => {
  const store = createSnapshotStore({ now: () => 0 })
  store.recordError("", "analysis-failed")
  // @ts-expect-error runtime guard against malformed events
  store.recordError(undefined, "analysis-failed")
  // @ts-expect-error runtime guard against malformed events
  store.recordError(1234, "analysis-failed")
  assert.equal(store.list().length, 0)
  assert.deepEqual(store.stats(), { sessionsWithSnapshots: 0, sessionsWithErrorOnly: 0 })
})

test("maxSnapshotsPerSession of 1 keeps only the newest (slice regression)", () => {
  const store = createSnapshotStore({ maxSnapshotsPerSession: 1, now: () => 0 })
  store.record(analysisWith({ tokens: 1, at: 1 }))
  store.record(analysisWith({ tokens: 2, at: 2 }))
  store.record(analysisWith({ tokens: 3, at: 3 }))
  const entry = store.get("ses_test")
  assert.equal(entry?.snapshots.length, 1)
  assert.equal(entry?.snapshots[0]!.totals.estimatedInputTokens, 3)
})

test("LRU eviction respects touch recency even when the clock never advances", () => {
  const store = createSnapshotStore({ maxSessions: 2, now: () => 7 }) // constant clock
  store.record(analysisWith({ sessionID: "ses_a", tokens: 1, at: 7 }))
  store.record(analysisWith({ sessionID: "ses_b", tokens: 2, at: 7 }))
  // Touch ses_a again: with a frozen clock only the sequence counter moves it forward.
  store.record(analysisWith({ sessionID: "ses_a", tokens: 3, at: 7 }))
  store.record(analysisWith({ sessionID: "ses_c", tokens: 4, at: 7 }))
  assert.equal(store.get("ses_b"), undefined) // b is now the least-recently-touched
  assert.ok(store.get("ses_a"))
  assert.ok(store.get("ses_c"))
})

test("list summaries are newest-first with latest-snapshot details", () => {
  let clock = 0
  const store = createSnapshotStore({ now: () => clock })
  store.record(analysisWith({ sessionID: "ses_a", tokens: 10, at: 1 }))
  clock = 100
  store.record(analysisWith({ sessionID: "ses_b", tokens: 20, at: 100 }))
  clock = 200
  store.record(analysisWith({ sessionID: "ses_a", tokens: 11, at: 200 }))
  const list = store.list()
  assert.deepEqual(list.map(s => s.sessionID), ["ses_a", "ses_b"])
  // lastActiveAt is the entry's own last activity, not "now" at listing time.
  assert.equal(list[0]!.lastActiveAt, 200)
  assert.equal(list[1]!.lastActiveAt, 100)
  assert.equal(list[0]!.snapshotCount, 2)
  assert.equal(list[0]!.lastEstimatedInputTokens % 100, 11)
  assert.equal(list[0]!.agent, "build")
  assert.equal(list[0]!.model.providerID, "anthropic")
})

test("dispose clears everything", () => {
  const store = createSnapshotStore({ now: () => 0 })
  store.record(analysisWith({ at: 0 }))
  store.dispose()
  assert.equal(store.get("ses_test"), undefined)
  assert.equal(store.list().length, 0)
})

test("stableStringify is key-order independent and signature ignores timestamps", () => {
  assert.equal(stableStringify({ a: 1, b: [2, 3] }), stableStringify({ b: [2, 3], a: 1 }))
  const a = analysisWith({ at: 1 })
  const b = analysisWith({ at: 9_999 })
  assert.equal(analysisSignature(a), analysisSignature(b))
})
