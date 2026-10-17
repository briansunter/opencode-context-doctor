import test from "node:test"
import assert from "node:assert/strict"
import { buildReportPayload } from "./report.ts"
import { fixtureAnalysis, fixtureReport } from "./fixtures.ts"

function analysisAt(tokens: number, at: number) {
  const base = fixtureAnalysis()
  return { ...base, capturedAt: at, totals: { ...base.totals, estimatedInputTokens: tokens } }
}

test("payload carries the latest snapshot and derived shares", () => {
  const payload = fixtureReport()
  assert.equal(payload.version, 1)
  assert.equal(payload.sessionID, "ses_test")
  const shares = payload.totals.systemShare + payload.totals.messageShare + payload.totals.toolShare
  assert.ok(Math.abs(shares - 1) < 0.001)
  assert.ok(payload.totals.systemTokens >= 0)
})

test("history keeps the newest snapshots, bounded by maxHistoryPoints", () => {
  const snapshots = Array.from({ length: 12 }, (_, i) => analysisAt((i + 1) * 100, i + 1))
  const payload = buildReportPayload({
    analysis: snapshots[snapshots.length - 1]!,
    snapshots,
    retention: { maxSessions: 50, maxSnapshotsPerSession: 20, sessionsTracked: 1, snapshotsForSession: snapshots.length },
    errors: { hookErrorCount: 0 },
    reported: {
      available: false,
      contextWindowSource: "none",
      notes: [],
    },
    maxHistoryPoints: 5,
  })
  assert.equal(payload.history.length, 5)
  assert.equal(payload.history[0]!.estimatedInputTokens, 800)
  assert.equal(payload.history[4]!.estimatedInputTokens, 1200)
})

test("errors and retention pass through untouched", () => {
  const payload = buildReportPayload({
    analysis: fixtureAnalysis(),
    snapshots: [fixtureAnalysis()],
    retention: { maxSessions: 10, maxSnapshotsPerSession: 4, sessionsTracked: 2, snapshotsForSession: 1 },
    errors: { hookErrorCount: 3, lastErrorAt: 42, lastErrorCode: "analysis-failed" },
    reported: { available: false, contextWindowSource: "none", notes: [] },
  })
  assert.deepEqual(payload.retention, { maxSessions: 10, maxSnapshotsPerSession: 4, sessionsTracked: 2, snapshotsForSession: 1 })
  assert.equal(payload.errors.hookErrorCount, 3)
  assert.equal(payload.errors.lastErrorCode, "analysis-failed")
})

test("reported section is carried verbatim and never rescales estimates", () => {
  const payload = fixtureReport()
  assert.equal(payload.reported.available, true)
  assert.equal(payload.reported.cumulative?.source, "session.context-sum")
  // Estimates unchanged by reported numbers: totals come from the analysis.
  assert.equal(payload.totals.estimatedInputTokens, payload.history[payload.history.length - 1]!.estimatedInputTokens)
})
