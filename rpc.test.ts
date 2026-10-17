import test from "node:test"
import assert from "node:assert/strict"
import { ContextDoctor } from "./rpc.ts"
import { fixtureReport, fixtureStats } from "./fixtures.ts"

// ---------------------------------------------------------------------------
// Minimal JSON-Schema-subset validator (test-only): the subset used by rpc.ts.
// ---------------------------------------------------------------------------

interface SchemaLike {
  type?: string
  properties?: Record<string, SchemaLike>
  required?: readonly string[]
  additionalProperties?: boolean
  items?: SchemaLike | boolean
  enum?: readonly unknown[]
  minLength?: number
  minimum?: number
}

export function validate(schema: SchemaLike | boolean | undefined, value: unknown, path = "$"): string[] {
  if (schema === undefined || schema === true) return []
  const errors: string[] = []
  if (schema === false) return [`${path}: schema forbids any value`]
  const s = schema
  if (s.type !== undefined) {
    const ok =
      (s.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) ||
      (s.type === "array" && Array.isArray(value)) ||
      (s.type === "string" && typeof value === "string") ||
      (s.type === "number" && typeof value === "number") ||
      (s.type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (s.type === "boolean" && typeof value === "boolean")
    if (!ok) return [`${path}: expected ${s.type}, got ${Array.isArray(value) ? "array" : typeof value}`]
  }
  if (s.enum !== undefined && !s.enum.some(option => option === value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(s.enum)}`)
  }
  if (typeof value === "string" && s.minLength !== undefined && value.length < s.minLength) {
    errors.push(`${path}: shorter than minLength ${s.minLength}`)
  }
  if (typeof value === "number" && s.minimum !== undefined && value < s.minimum) {
    errors.push(`${path}: below minimum ${s.minimum}`)
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of s.required ?? []) {
      if (!(key in record)) errors.push(`${path}.${key}: required but missing`)
    }
    if (s.properties) {
      for (const [key, child] of Object.entries(s.properties)) {
        if (key in record) errors.push(...validate(child, record[key], `${path}.${key}`))
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in s.properties)) errors.push(`${path}.${key}: additional property not allowed`)
        }
      }
    }
  }
  if (Array.isArray(value) && s.items && typeof s.items === "object") {
    value.forEach((item, index) => {
      errors.push(...validate(s.items as SchemaLike, item, `${path}[${index}]`))
    })
  }
  return errors
}

const reportOutput = ContextDoctor.methods.report.output as SchemaLike
const listOutput = ContextDoctor.methods.list.output as SchemaLike
const capturedEvent = ContextDoctor.events.captured.schema as SchemaLike

test("the rpc definition is declared under the context-doctor id", () => {
  assert.equal(ContextDoctor.id, "context-doctor")
  assert.ok(ContextDoctor.methods.list && ContextDoctor.methods.report)
  assert.ok(ContextDoctor.events.captured)
})

test("a full report payload validates against the output schema", () => {
  const errors = validate(reportOutput, fixtureReport())
  assert.deepEqual(errors, [])
})

test("schemas reject missing required fields, wrong types, and extra keys", () => {
  const report = fixtureReport() as unknown as Record<string, unknown>
  const missing = { ...report, totals: undefined }
  assert.ok(validate(reportOutput, missing).some(e => e.includes("totals: expected")))

  const badShare = structuredCopy(report)
  ;(badShare.totals as Record<string, unknown>).systemShare = "36%"
  assert.ok(validate(reportOutput, badShare).some(e => e.includes("systemShare: expected number")))

  const extra = structuredCopy(report)
  ;(extra as Record<string, unknown>).bonus = true
  assert.ok(validate(reportOutput, extra).some(e => e.includes("bonus: additional property")))
})

test("the list output schema validates session summaries", () => {
  const report = fixtureReport()
  const payload = {
    sessions: [
      {
        sessionID: "ses_x",
        agent: "build",
        model: report.model,
        snapshotCount: 1,
        lastCapturedAt: 1,
        lastEstimatedInputTokens: 5,
        lastMessageCount: 2,
        hookErrorCount: 0,
        lastActiveAt: 3,
      },
    ],
  }
  assert.deepEqual(validate(listOutput, payload), [])
  assert.ok(validate(listOutput, { sessions: [payload.sessions[0]!, ...[payload.sessions[0]!].map(s => ({ ...s, snapshotCount: 0 }))] }).some(e => e.includes("below minimum")))
})

test("the captured event schema accepts exactly ids, timestamps, and estimate totals", () => {
  assert.deepEqual(validate(capturedEvent, { sessionID: "ses_x", capturedAt: 1, estimatedInputTokens: 10 }), [])
  assert.ok(validate(capturedEvent, { sessionID: "ses_x", capturedAt: 1 }).length > 0)
  assert.ok(validate(capturedEvent, { sessionID: "ses_x", capturedAt: 1, estimatedInputTokens: 10, raw: "text" }).some(e => e.includes("raw")))
})

test("declared error payloads validate", () => {
  const unknown = ContextDoctor.methods.report.errors?.unknown_session as SchemaLike
  assert.deepEqual(validate(unknown, { sessionID: "ses_x" }), [])
  assert.deepEqual(
    validate(unknown, { sessionID: "ses_x", reason: "no_capture", instanceDirectory: "/work/project" }),
    [],
  )
  assert.deepEqual(
    validate(unknown, { sessionID: "ses_x", reason: "hook_error", instanceDirectory: "/work/project", hookErrorCount: 2, lastErrorCode: "analysis-failed" }),
    [],
  )
  // The reason vocabulary is closed and free-form codes are rejected.
  assert.ok(validate(unknown, { sessionID: "ses_x", reason: "kaput" }).some(e => e.includes("not in enum")))
  assert.ok(validate(unknown, { sessionID: "ses_x", lastErrorCode: "exploded-with-secret" }).some(e => e.includes("not in enum")))
  const invalid = ContextDoctor.methods.report.errors?.invalid_input as SchemaLike
  assert.ok(validate(invalid, {}).length > 0)
})

test("the diagnostics output schema validates bounded instance counters only", () => {
  const diagnosticsOutput = ContextDoctor.methods.diagnostics?.output as SchemaLike
  const healthy = {
    instanceDirectory: "/work/project",
    hookInvocations: 12,
    capturesStored: 9,
    captureFailures: 0,
    sessionsWithSnapshots: 3,
    sessionsWithErrorOnly: 0,
    maxSessions: 50,
    maxSnapshotsPerSession: 20,
  }
  assert.deepEqual(validate(diagnosticsOutput, healthy), [])
  const failing = { ...healthy, captureFailures: 3, lastFailureAt: 1_700_000_000_000, lastFailureCode: "analysis-failed" }
  assert.deepEqual(validate(diagnosticsOutput, failing), [])
  // Optional failure fields stay inside the closed vocabulary.
  assert.ok(validate(diagnosticsOutput, { ...failing, lastFailureCode: "secret-laden-message" }).some(e => e.includes("not in enum")))
  // No extra keys (e.g. no error text) are allowed.
  assert.ok(validate(diagnosticsOutput, { ...healthy, message: "boom" }).some(e => e.includes("message: additional property")))
  // Required instance fields cannot be missing.
  assert.ok(validate(diagnosticsOutput, { instanceDirectory: "/x" }).some(e => e.includes("hookInvocations: required")))
})

test("the diagnostics persistence block validates with closed error codes", () => {
  const diagnosticsOutput = ContextDoctor.methods.diagnostics?.output as SchemaLike
  const base = {
    instanceDirectory: "/work/project",
    hookInvocations: 1,
    capturesStored: 1,
    captureFailures: 0,
    sessionsWithSnapshots: 1,
    sessionsWithErrorOnly: 0,
    maxSessions: 50,
    maxSnapshotsPerSession: 20,
  }
  const active = {
    ...base,
    persistence: {
      status: "active",
      mode: "sqlite-worker",
      directory: "/state",
      dbPath: "/state/context-doctor.db",
      engine: "bun:sqlite",
      flushes: 2,
      flushFailures: 0,
      flushedSessions: 5,
      lastFlushAt: 1,
      dirtySessions: 0,
      hydratedSessions: 3,
      hydratedAt: 2,
      retention: { maxAgeMs: 2_592_000_000, byteBudgetBytes: 33_554_432, maxSessionsPerLocation: 50 },
      totals: { locations: 2, sessions: 4, snapshots: 9, fileBytes: 1_000, payloadBytes: 500, rawBytes: 2_000, compressionRatio: 4 },
    },
  }
  const activeErrors = validate(diagnosticsOutput, active)
  assert.deepEqual(activeErrors, [])
  // Degraded with a fixed code only.
  const degraded = {
    ...base,
    persistence: { status: "degraded", mode: "sqlite-worker", lastErrorCode: "db-open-failed", lastErrorAt: 3, flushes: 0, flushFailures: 1, flushedSessions: 0, dirtySessions: 2, hydratedSessions: 0, retention: { maxAgeMs: 2_592_000_000, byteBudgetBytes: 33_554_432, maxSessionsPerLocation: 50 } },
  }
  assert.deepEqual(validate(diagnosticsOutput, degraded), [])
  // Free-form persistence error text is rejected.
  assert.ok(
    validate(diagnosticsOutput, { ...base, persistence: { ...degraded.persistence, lastErrorCode: "secret-laden-message" } }).some(e => e.includes("not in enum")),
  )
  assert.ok(validate(diagnosticsOutput, { ...base, persistence: { ...degraded.persistence, status: "exploded" } }).some(e => e.includes("not in enum")))
})

test("the stats output schema validates both aggregate variants with closed codes", () => {
  const statsOutput = ContextDoctor.methods.stats?.output as SchemaLike
  const available = structuredCopy(fixtureStats())
  assert.deepEqual(validate(statsOutput, available), [])
  const unavailable = structuredCopy(fixtureStats({ available: false, reason: "disabled" })) as unknown as Record<string, unknown>
  unavailable.totals = { locations: 0, sessions: 0, snapshots: 0, payloadBytes: 0, rawBytes: 0 }
  unavailable.context = { sessionsWithSnapshots: 0, avgLatestEstimatedInputTokens: 0, peakEstimatedInputTokens: 0, perModel: [] }
  unavailable.retention = { ...(unavailable.retention as Record<string, unknown>), sessions: 0, snapshots: 0 }
  delete unavailable.usage
  delete unavailable.tools
  assert.deepEqual(validate(statsOutput, unavailable), [])
  // The reason vocabulary is closed; free-form text is rejected.
  assert.ok(validate(statsOutput, { ...unavailable, reason: "secret-laden-message" }).some(e => e.includes("not in enum")))
  // Coverage is a fixed label, not attacker-controlled free text.
  assert.ok(validate(statsOutput, { ...unavailable, reason: "disabled", coverage: "every-session-ever" }).some(e => e.includes("not in enum")))
  // Required sections cannot be missing.
  const stripped = structuredCopy(fixtureStats()) as unknown as Record<string, unknown>
  delete stripped.retention
  assert.ok(validate(statsOutput, stripped).some(e => e.includes("retention: required")))
})

function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
