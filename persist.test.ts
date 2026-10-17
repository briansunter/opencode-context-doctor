/**
 * Deterministic persistence-manager tests using a fully controllable fake
 * backend (no real worker): blocking writers, bounded queues, coalescing,
 * the load-vs-live hydration race, failure degradation, and dispose
 * behavior. Real-worker/SQLite roundtrips live in persist-worker.test.ts.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createPersistence, defaultStorageDirectory, locationKey, type PersistenceBackend } from "./persist.ts"
import type { PersistErrorCode } from "./error-codes.ts"
import type { PersistRequest, PersistResponse } from "./persist-protocol.ts"
import { createSnapshotStore } from "./store.ts"
import type { SnapshotStore } from "./store.ts"
import { RAW_SECRET, fixtureAnalysis } from "./fixtures.ts"

class FakeBackend implements PersistenceBackend {
  readonly posted: PersistRequest[] = []
  private listener: ((response: PersistResponse) => void) | undefined
  terminated = false

  post(message: PersistRequest): void {
    this.posted.push(message)
  }

  onMessage(listener: (response: PersistResponse) => void): void {
    this.listener = listener
  }

  async terminate(): Promise<void> {
    this.terminated = true
  }

  requestsOf<K extends PersistRequest["kind"]>(kind: K): Extract<PersistRequest, { kind: K }>[] {
    return this.posted.filter(request => request.kind === kind) as Extract<PersistRequest, { kind: K }>[]
  }

  respond(request: PersistRequest, result: unknown): void {
    this.listener?.({ id: request.id, ok: true, kind: request.kind, result } as PersistResponse)
  }

  fail(request: PersistRequest, code: PersistErrorCode): void {
    this.listener?.({ id: request.id, ok: false, code })
  }

  /** Respond to the init request so the manager becomes active. */
  async untilActive(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const init = this.requestsOf("init")[0]
      if (init !== undefined) {
        this.respond(init, { dbPath: "/tmp/fake.db", engine: "bun:sqlite", recoveredFromCorruption: false, schemaVersion: 1 })
        await new Promise(resolve => setTimeout(resolve, 5))
        return
      }
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    throw new Error("init was never posted")
  }

  async untilPosted<K extends PersistRequest["kind"]>(kind: K): Promise<Extract<PersistRequest, { kind: K }>> {
    // Only requests posted AFTER this call count (a late-arriving responder
    // must never observe a stale, already-answered request).
    const baseline = this.posted.length
    for (let i = 0; i < 200; i += 1) {
      const request = this.posted.slice(baseline).find(pending => pending.kind === kind)
      if (request !== undefined) return request as Extract<PersistRequest, { kind: K }>
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    throw new Error(`${kind} was never posted`)
  }
}

const budgets = { maxSessionsPerLocation: 50, maxAgeMs: 30 * 24 * 60 * 60 * 1000, byteBudgetBytes: 32 * 1024 * 1024 }

function analysisFor(sessionID: string, capturedAt: number, tokens: number) {
  const base = fixtureAnalysis()
  return { ...base, sessionID, capturedAt, totals: { ...base.totals, estimatedInputTokens: tokens } }
}

function makeManager(overrides: { backend?: FakeBackend; store?: SnapshotStore; debounceMs?: number } = {}) {
  const backend = overrides.backend ?? new FakeBackend()
  const store = overrides.store ?? createSnapshotStore()
  const persistence = createPersistence(store, {
    directory: "/work/project",
    storageDirectory: "/tmp/context-doctor-test-state",
    budgets,
    debounceMs: overrides.debounceMs ?? 60_000,
    backend: () => backend,
  })
  return { backend, store, persistence }
}

test("location keys and the default state directory follow XDG conventions", () => {
  assert.equal(locationKey("/work/project"), "/work/project")
  assert.equal(locationKey("/work/project", "ws1"), "/work/project#ws1")
  assert.equal(locationKey("/work/project", ""), "/work/project")
  const dir = defaultStorageDirectory()
  assert.ok(dir.endsWith("opencode-context-doctor"), `unexpected default dir ${dir}`)
  assert.ok(!dir.includes("opencode/"), "own data must not live inside OpenCode's data directory")
})

test("markDirty is synchronous and bounded while the writer is blocked; one flush in flight", async () => {
  const { backend, store, persistence } = makeManager()
  await backend.untilActive()

  // 100 captures of 25 sessions while the worker never acks a flush.
  let syncReturn: unknown
  for (let i = 0; i < 100; i += 1) {
    const sessionID = `ses_${i % 25}`
    const result = store.record(analysisFor(sessionID, 1_000 + i, 10_000 + i))
    assert.equal(result.stored, true)
    syncReturn = persistence.markDirty(sessionID)
  }
  assert.equal(syncReturn, undefined, "markDirty must not return a promise (context-hook path)")
  assert.equal(persistence.health().dirtySessions, 25, "dirty set bounded by the store's session cap")
  // The 60s debounce must not have posted a write on its own.
  assert.equal(backend.requestsOf("flush").length, 0)

  const flushing = persistence.flushNow()
  const flushRequest = await backend.untilPosted("flush")
  assert.equal(flushRequest.sessions.length, 25, "one coalesced batch, one row per dirty session")

  // Captures during the in-flight flush coalesce into the NEXT batch.
  store.record(analysisFor("ses_extra", 2_000, 99))
  persistence.markDirty("ses_extra")

  backend.respond(flushRequest, { written: 25, rawBytes: 100, compressedBytes: 50, maintenanceRan: true, deletedByMaintenance: 0 })
  await flushing
  assert.ok(backend.requestsOf("flush").length >= 1)

  // Next flush picks up only the newly dirty session, with its LATEST state.
  const second = persistence.flushNow()
  const secondRequest = await backend.untilPosted("flush")
  assert.deepEqual(
    secondRequest.sessions.map(row => row.sessionID),
    ["ses_extra"],
  )
  assert.equal((secondRequest.sessions[0]!.record.snapshots as unknown[]).length, 1, "latest snapshot state sent")
  backend.respond(secondRequest, { written: 1, rawBytes: 4, compressedBytes: 2, maintenanceRan: false, deletedByMaintenance: 0 })
  await second

  const health = persistence.health()
  assert.equal(health.status, "active")
  assert.equal(health.flushes, 2)
  assert.equal(health.flushFailures, 0)
  assert.equal(health.dirtySessions, 0)
  assert.equal(health.flushedSessions, 26)
  await persistence.dispose()
  assert.equal(backend.terminated, true)
})

test("a failed flush restores dirty marks and retries with the latest state", async () => {
  const { backend, store, persistence } = makeManager()
  await backend.untilActive()

  store.record(analysisFor("ses_a", 1_000, 5))
  persistence.markDirty("ses_a")
  const first = persistence.flushNow()
  const firstRequest = await backend.untilPosted("flush")
  backend.fail(firstRequest, "busy-timeout")
  await first
  assert.equal(persistence.health().flushFailures, 1)
  assert.equal(persistence.health().lastErrorCode, "busy-timeout")
  assert.equal(persistence.health().dirtySessions, 1, "dirty marks restored after failure")

  // Newer capture wins before the retry: the retry must persist the latest.
  store.record(analysisFor("ses_a", 2_000, 6))
  persistence.markDirty("ses_a")
  const retry = persistence.flushNow()
  const retryRequest = await backend.untilPosted("flush")
  assert.equal(retryRequest.sessions.length, 1)
  const snapshots = retryRequest.sessions[0]!.record.snapshots as { capturedAt: number }[]
  assert.equal(snapshots.length, 2, "both snapshots persisted, latest included")
  backend.respond(retryRequest, { written: 1, rawBytes: 10, compressedBytes: 5, maintenanceRan: false, deletedByMaintenance: 0 })
  await retry
  assert.equal(persistence.health().flushes, 1)
  await persistence.dispose()
})

test("load-vs-live hydration race: live captures always win; other sessions restore", async () => {
  const { backend, store, persistence } = makeManager()
  await backend.untilActive()

  // A live capture happens BEFORE hydration completes (store created first).
  store.record(analysisFor("ses_live", 5_000, 42))

  const hydration = persistence.hydrate()
  // The reply arrives later, carrying an OLDER row for the live session.
  const hydrateRequest = await backend.untilPosted("hydrate")
  backend.respond(hydrateRequest, {
    sessions: [
      {
        sessionID: "ses_live",
        lastActiveAt: 1_000,
        snapshots: [analysisFor("ses_live", 1_000, 7)],
        errors: { count: 0 },
      },
      {
        sessionID: "ses_disk",
        lastActiveAt: 900,
        snapshots: [analysisFor("ses_disk", 900, 11)],
        errors: { count: 2, lastAt: 950, lastCode: "analysis-failed" },
      },
    ],
    skipped: 0,
  })
  await hydration

  assert.equal(store.get("ses_live")!.snapshots.length, 1, "live entry must not be overwritten by older disk state")
  assert.equal(store.get("ses_live")!.snapshots[0]!.totals.estimatedInputTokens, 42)
  const disk = store.get("ses_disk")
  assert.ok(disk, "unrelated disk session restored")
  assert.equal(disk!.snapshots.length, 1)
  assert.equal(disk!.errors.count, 2)
  assert.equal(disk!.errors.lastCode, "analysis-failed")
  // A re-observation identical to the hydrated newest snapshot still dedupes
  // (the signature is re-derived on hydrate, reusing existing store work).
  assert.equal(store.record(analysisFor("ses_disk", 900, 11)).stored, false)
  assert.equal(persistence.health().hydratedSessions, 1)
  await persistence.dispose()
})

test("hydration failure degrades explicitly and in-memory analytics continue", async () => {
  const { backend, store, persistence } = makeManager()
  await backend.untilActive()
  const hydration = persistence.hydrate()
  const hydrateRequest = await backend.untilPosted("hydrate")
  backend.fail(hydrateRequest, "db-corrupt")
  await hydration

  store.record(analysisFor("ses_ok", 1, 1))
  persistence.markDirty("ses_ok")
  const flushing = persistence.flushNow()
  const flushRequest = await backend.untilPosted("flush")
  assert.equal(flushRequest.sessions.length, 1, "flushes still work after hydration failure")
  backend.respond(flushRequest, { written: 1, rawBytes: 2, compressedBytes: 1, maintenanceRan: false, deletedByMaintenance: 0 })
  await flushing

  const health = persistence.health()
  assert.equal(health.status, "active")
  assert.equal(health.lastErrorCode, "db-corrupt")
  assert.equal(health.hydratedSessions, 0)
  assert.equal(store.list().length, 1)
  await persistence.dispose()
})

test("init failure degrades to a fixed code and all persistence APIs stay safe", async () => {
  const { backend, persistence, store } = makeManager()
  const settled = persistence.hydrate()
  const initRequest = backend.requestsOf("init")[0]! // posted synchronously at construction
  backend.fail(initRequest, "db-open-failed")
  await settled

  const health = persistence.health()
  assert.equal(health.status, "degraded")
  assert.equal(health.lastErrorCode, "db-open-failed")

  // markDirty must be a safe no-op; flushNow and stats resolve without throwing.
  persistence.markDirty("ses_x")
  await persistence.flushNow()
  assert.equal(backend.requestsOf("flush").length, 0, "degraded manager must not write")
  const stats = await persistence.globalStats(10)
  assert.equal(stats.available, false)
  assert.equal(stats.reason, "db-open-failed")
  assert.equal(store.list().length, 0)
  await persistence.dispose()
})

test("worker spawn failure is reported as disabled, never thrown", async () => {
  const store = createSnapshotStore()
  const persistence = createPersistence(store, {
    directory: "/work/project",
    storageDirectory: "/tmp/unused",
    budgets,
    backend: () => {
      throw new Error("no worker_threads in this runtime")
    },
  })
  await persistence.hydrate()
  const health = persistence.health()
  assert.equal(health.status, "disabled")
  assert.equal(health.mode, "none")
  assert.equal(health.lastErrorCode, "worker-spawn-failed")
  const stats = await persistence.globalStats(5)
  assert.equal(stats.available, false)
  assert.equal(stats.reason, "disabled")
  await persistence.dispose()
})

test("flush payloads never contain raw content or free-form error text", async () => {
  const { backend, store, persistence } = makeManager()
  await backend.untilActive()
  store.record(fixtureAnalysis())
  persistence.markDirty("ses_test")
  const flushing = persistence.flushNow()
  const flushRequest = await backend.untilPosted("flush")
  const serialized = JSON.stringify(flushRequest)
  assert.ok(!serialized.includes(RAW_SECRET), "raw content must never enter persistence messages")
  assert.ok(!serialized.includes("Error:"), "no error strings in persistence messages")
  backend.respond(flushRequest, { written: 1, rawBytes: 3, compressedBytes: 1, maintenanceRan: false, deletedByMaintenance: 0 })
  await flushing
  await persistence.dispose()
})
