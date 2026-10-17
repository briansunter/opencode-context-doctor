/**
 * Real persistence-worker integration tests (Bun runtime: real worker
 * thread, real bun:sqlite, real gzip). Covers restart roundtrip,
 * per-location isolation, snapshot-limit retention, reload writer
 * ownership, corruption recovery, unwritable-state degradation, on-disk
 * privacy, retention budgets, and aggregate anti-double-counting.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createPersistence } from "./persist.ts"
import { createSnapshotStore } from "./store.ts"
import type { SnapshotStore } from "./store.ts"
import { fixtureAnalysis, RAW_SECRET } from "./fixtures.ts"
import type { GlobalStatsPayload } from "./types.ts"

const budgets = { maxSessionsPerLocation: 50, maxAgeMs: 30 * 24 * 60 * 60 * 1000, byteBudgetBytes: 32 * 1024 * 1024 }

function analysisFor(sessionID: string, capturedAt: number, tokens: number) {
  const base = fixtureAnalysis()
  return { ...base, sessionID, capturedAt, totals: { ...base.totals, estimatedInputTokens: tokens } }
}

function tempStateDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "context-doctor-persist-"))
}

interface Harness {
  store: SnapshotStore
  persistence: ReturnType<typeof createPersistence>
  directory: string
}

function managerFor(stateDirectory: string, options: { directory?: string; workspaceID?: string; store?: SnapshotStore; budgets?: typeof budgets; now?: () => number } = {}): Harness {
  const store = options.store ?? createSnapshotStore(options.now !== undefined ? { now: options.now } : {})
  const persistence = createPersistence(store, {
    directory: options.directory ?? "/work/project",
    ...(options.workspaceID !== undefined ? { workspaceID: options.workspaceID } : {}),
    storageDirectory: stateDirectory,
    budgets: options.budgets ?? budgets,
    debounceMs: 60_000,
  })
  return { store, persistence, directory: options.directory ?? "/work/project" }
}

async function waitForActive(persistence: ReturnType<typeof createPersistence>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (persistence.health().status !== "pending") return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error("persistence never became ready")
}

const clean = (harness: Harness) => harness.persistence.dispose()

test("restart roundtrip: snapshots, errors, and usage survive worker recreation (reload)", async () => {
  const state = tempStateDirectory()
  const first = managerFor(state)

  await waitForActive(first.persistence)
  await first.persistence.hydrate()
  first.store.record(analysisFor("ses_round", 1_000, 100))
  first.store.record(analysisFor("ses_round", 2_000, 150))
  first.store.recordError("ses_round", "analysis-failed")
  // Apply a cumulative usage event like handleEvent does (replace-not-sum).
  const entry = first.store.get("ses_round")!
  entry.usage = {
    ...entry.usage,
    live: { tokens: { input: 4_000, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, capturedAt: 2_500, source: "session.usage.updated", ephemeral: true },
  }
  first.persistence.markDirty("ses_round")
  await first.persistence.flushNow()
  await clean(first)

  // "Restart": a fresh store + worker on the same state directory.
  const second = managerFor(state)
  await waitForActive(second.persistence)
  await second.persistence.hydrate()
  const restored = second.store.get("ses_round")
  assert.ok(restored, "session must survive the restart")
  assert.equal(restored!.snapshots.length, 2)
  assert.equal(restored!.snapshots[1]!.totals.estimatedInputTokens, 150)
  assert.equal(restored!.errors.count, 1)
  assert.equal(restored!.errors.lastCode, "analysis-failed")
  assert.equal(second.persistence.health().hydratedSessions, 1)

  // The persisted usage columns answer the global aggregate (metadata only).
  const stats = await second.persistence.globalStats(10)
  assert.equal(stats.available, true)
  assert.equal(stats.usage?.sessionsWithUsage, 1)
  assert.equal(stats.usage?.tokens.input, 4_000, "cumulative usage persisted once, latest value")
  await clean(second)
  rmSync(state, { recursive: true, force: true })
})

test("per-location isolation: each location hydrates only its own rows", async () => {
  const state = tempStateDirectory()
  const one = managerFor(state, { directory: "/work/one" })
  const two = managerFor(state, { directory: "/work/two" })
  await waitForActive(one.persistence)
  await waitForActive(two.persistence)
  await one.persistence.hydrate()
  await two.persistence.hydrate()

  one.store.record(analysisFor("ses_one", 1_000, 10))
  two.store.record(analysisFor("ses_two", 1_000, 20))
  one.persistence.markDirty("ses_one")
  two.persistence.markDirty("ses_two")
  await one.persistence.flushNow()
  await two.persistence.flushNow()

  const hydratedOne = managerFor(state, { directory: "/work/one" })
  const hydratedTwo = managerFor(state, { directory: "/work/two" })
  await waitForActive(hydratedOne.persistence)
  await waitForActive(hydratedTwo.persistence)
  await hydratedOne.persistence.hydrate()
  await hydratedTwo.persistence.hydrate()
  assert.ok(hydratedOne.store.get("ses_one"))
  assert.equal(hydratedOne.store.get("ses_two"), undefined, "other location's sessions must not leak")
  assert.ok(hydratedTwo.store.get("ses_two"))
  assert.equal(hydratedTwo.store.get("ses_one"), undefined)

  // The global aggregate intentionally spans locations (dedicated endpoint).
  const stats = await hydratedOne.persistence.globalStats(10)
  assert.equal(stats.available, true)
  assert.equal(stats.totals.locations, 2)
  assert.equal(stats.totals.sessions, 2)
  assert.equal(stats.locations.length, 2)
  await Promise.all([clean(one), clean(two), clean(hydratedOne), clean(hydratedTwo)])
  rmSync(state, { recursive: true, force: true })
})

test("workspace discriminator keys a location independently from its directory", async () => {
  const state = tempStateDirectory()
  const plain = managerFor(state, { directory: "/work/project" })
  const spaced = managerFor(state, { directory: "/work/project", workspaceID: "ws1" })
  await waitForActive(plain.persistence)
  await waitForActive(spaced.persistence)
  await plain.persistence.hydrate()
  await spaced.persistence.hydrate()

  plain.store.record(analysisFor("ses_plain", 1_000, 5))
  spaced.store.record(analysisFor("ses_spaced", 1_000, 6))
  plain.persistence.markDirty("ses_plain")
  spaced.persistence.markDirty("ses_spaced")
  await plain.persistence.flushNow()
  await spaced.persistence.flushNow()

  const hydratedPlain = managerFor(state, { directory: "/work/project" })
  await waitForActive(hydratedPlain.persistence)
  await hydratedPlain.persistence.hydrate()
  assert.ok(hydratedPlain.store.get("ses_plain"))
  assert.equal(hydratedPlain.store.get("ses_spaced"), undefined, "workspace-scoped instance keeps its own rows")
  await Promise.all([clean(plain), clean(spaced), clean(hydratedPlain)])
  rmSync(state, { recursive: true, force: true })
})

test("limits=1: only the newest snapshot is persisted and restored", async () => {
  const state = tempStateDirectory()
  const writer = managerFor(state, { store: createSnapshotStore({ maxSnapshotsPerSession: 1 }) })
  await waitForActive(writer.persistence)
  await writer.persistence.hydrate()
  writer.store.record(analysisFor("ses_lim", 1_000, 100))
  writer.store.record(analysisFor("ses_lim", 2_000, 200))
  writer.persistence.markDirty("ses_lim")
  await writer.persistence.flushNow()
  await clean(writer)

  const reader = managerFor(state, { store: createSnapshotStore({ maxSnapshotsPerSession: 1 }) })
  await waitForActive(reader.persistence)
  await reader.persistence.hydrate()
  const restored = reader.store.get("ses_lim")
  assert.equal(restored!.snapshots.length, 1)
  assert.equal(restored!.snapshots[0]!.totals.estimatedInputTokens, 200)
  assert.equal(restored!.snapshots[0]!.capturedAt, 2_000)
  await clean(reader)
  rmSync(state, { recursive: true, force: true })
})

test("reload writer ownership: a stale flush from an old instance cannot clobber newer rows", async () => {
  const state = tempStateDirectory()
  // Clocks are anchored to the real present (a frozen past clock would make
  // the age sweep - correctly - treat the rows as ancient); only their
  // RELATIVE order matters for the writer-ownership guard.
  const T = Date.now()
  // Old instance's store clock stops at T; the replacement runs at T+1000.
  const old = managerFor(state, { directory: "/work/project", store: createSnapshotStore({ now: () => T }) })
  await waitForActive(old.persistence)
  await old.persistence.hydrate()
  old.store.record(analysisFor("ses_race", T, 111))
  old.persistence.markDirty("ses_race")
  await old.persistence.flushNow()

  const fresh = managerFor(state, { directory: "/work/project", store: createSnapshotStore({ now: () => T + 1000 }) })
  await waitForActive(fresh.persistence)
  await fresh.persistence.hydrate()
  assert.equal(fresh.store.get("ses_race")!.snapshots.length, 1, "new instance hydrated the old row")
  fresh.store.record(analysisFor("ses_race", T + 1000, 222))
  fresh.persistence.markDirty("ses_race")
  await fresh.persistence.flushNow()

  // The old instance flushes again AFTER the replacement wrote newer data.
  old.store.record(analysisFor("ses_race", T, 111 + 1)) // still clocked at T
  old.persistence.markDirty("ses_race")
  await old.persistence.flushNow()

  const verifier = managerFor(state, { directory: "/work/project" })
  await waitForActive(verifier.persistence)
  await verifier.persistence.hydrate()
  const row = verifier.store.get("ses_race")!
  assert.equal(row.snapshots.at(-1)!.totals.estimatedInputTokens, 222, "newer instance's data must win")
  assert.ok(row.lastActiveAt >= T + 1000)
  await Promise.all([clean(old), clean(fresh), clean(verifier)])
  rmSync(state, { recursive: true, force: true })
})

test("corrupt database is moved aside and persistence recovers on a fresh one", async () => {
  const state = tempStateDirectory()
  mkdirSync(state, { recursive: true })
  const dbPath = path.join(state, "context-doctor.db")
  writeFileSync(dbPath, Buffer.from("this is definitely not a sqlite database file"))

  const manager = managerFor(state)
  await waitForActive(manager.persistence)
  await manager.persistence.hydrate()
  const health = manager.persistence.health()
  assert.equal(health.status, "active")
  assert.equal(health.lastErrorCode, "db-corrupt")
  const after = readdirSafe(state)
  assert.ok(after.some(name => name.startsWith("context-doctor.db.corrupt-")), "corrupt file moved aside, own files only")

  // Writes work on the recovered database.
  manager.store.record(analysisFor("ses_recover", 1_000, 9))
  manager.persistence.markDirty("ses_recover")
  await manager.persistence.flushNow()
  const stats = await manager.persistence.globalStats(5)
  assert.equal(stats.totals.sessions, 1)
  await clean(manager)
  rmSync(state, { recursive: true, force: true })
})

test("unwritable state directory degrades explicitly; nothing is ever thrown", async () => {
  const blocked = path.join(tmpdir(), `context-doctor-blocked-${Date.now()}`)
  const state = tempStateDirectory()
  mkdirSync(blocked, { recursive: true })
  chmodSync(blocked, 0o000)
  try {
    const manager = managerFor(path.join(blocked, "state"))
    for (let i = 0; i < 100; i += 1) {
      if (manager.persistence.health().status !== "pending") break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const health = manager.persistence.health()
    assert.equal(health.status, "degraded")
    assert.ok(health.lastErrorCode !== undefined, "fixed error code recorded")
    manager.store.record(analysisFor("ses_offline", 1, 1))
    manager.persistence.markDirty("ses_offline")
    await manager.persistence.flushNow() // no-op, resolves
    assert.equal(manager.store.list().length, 1, "in-memory analytics continue")
    await clean(manager)
  } finally {
    chmodSync(blocked, 0o700)
    rmSync(blocked, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

test("on-disk privacy: database bytes contain no raw content; permissions are restrictive", async () => {
  const state = tempStateDirectory()
  const manager = managerFor(state)
  await waitForActive(manager.persistence)
  await manager.persistence.hydrate()
  manager.store.record(fixtureAnalysis()) // fixture carries RAW_SECRET in its source event
  manager.persistence.markDirty("ses_test")
  await manager.persistence.flushNow()
  await clean(manager)

  const dbPath = path.join(state, "context-doctor.db")
  const contents = Buffer.concat([readFileSync(dbPath), safeRead(`${dbPath}-wal`)])
  assert.ok(!contents.toString("latin1").includes(RAW_SECRET), "raw content must never reach disk")
  const mode = statSync(dbPath).mode & 0o777
  assert.equal(mode, 0o600, "database file must be owner-only")
  assert.equal(statSync(state).mode & 0o777, 0o700, "state directory must be owner-only")
  rmSync(state, { recursive: true, force: true })
})

test("retention: the global byte budget evicts oldest rows via batched maintenance", async () => {
  const state = tempStateDirectory()
  const tightBudgets = { maxSessionsPerLocation: 50, maxAgeMs: 30 * 24 * 60 * 60 * 1000, byteBudgetBytes: 4_096 }
  const writer = managerFor(state, { budgets: tightBudgets })
  await waitForActive(writer.persistence)
  await writer.persistence.hydrate()
  for (let i = 0; i < 12; i += 1) {
    writer.store.record(analysisFor(`ses_budget_${i}`, 1_000 + i, 1_000 + i))
    writer.persistence.markDirty(`ses_budget_${i}`)
  }
  await writer.persistence.flushNow() // first flush runs maintenance
  const stats = await writer.persistence.globalStats(50)
  assert.ok(stats.totals.payloadBytes <= tightBudgets.byteBudgetBytes, `payload bytes ${stats.totals.payloadBytes} must respect the budget`)
  assert.ok(stats.totals.sessions < 12, "oldest rows evicted to fit the budget")
  assert.ok(stats.totals.sessions >= 1, "newest rows retained")
  await clean(writer)
  rmSync(state, { recursive: true, force: true })
})

test("aggregate never double-counts: one session, many snapshots and replaced usage", async () => {
  const state = tempStateDirectory()
  const manager = managerFor(state)
  await waitForActive(manager.persistence)
  await manager.persistence.hydrate()

  for (let i = 1; i <= 3; i += 1) {
    manager.store.record(analysisFor("ses_once", 1_000 * i, 10_000 * i))
    manager.persistence.markDirty("ses_once")
  }
  // Two cumulative usage events: the later one must REPLACE the earlier.
  const entry = manager.store.get("ses_once")!
  entry.usage = {
    ...entry.usage,
    live: { tokens: { input: 100, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, capturedAt: 4_000, source: "session.usage.updated", ephemeral: true },
  }
  entry.usage = {
    auxiliary: entry.usage.auxiliary,
    live: { tokens: { input: 500, output: 2, reasoning: 0, cacheRead: 10, cacheWrite: 0 }, capturedAt: 5_000, source: "session.usage.updated", ephemeral: true },
  }
  manager.persistence.markDirty("ses_once")
  await manager.persistence.flushNow()

  const stats: GlobalStatsPayload = await manager.persistence.globalStats(10)
  assert.equal(stats.totals.sessions, 1)
  assert.equal(stats.totals.snapshots, 3, "snapshot history retained")
  assert.equal(stats.context.sessionsWithSnapshots, 1, "one session, counted once")
  assert.equal(stats.context.avgLatestEstimatedInputTokens, 30_000, "avg uses the session's LATEST context, not the sum (60k would be double-counting)")
  assert.equal(stats.context.peakEstimatedInputTokens, 30_000)
  assert.equal(stats.usage?.tokens.input, 500, "usage totals use the latest cumulative value (replace, not sum)")
  assert.equal(stats.usage?.tokens.cacheRead, 10)
  // Tools aggregate the latest retained snapshot only.
  const read = stats.tools?.schema.find(tool => tool.id === "read")
  assert.ok(read)
  assert.equal(read!.sessions, 1, "a tool in one session counts once regardless of snapshot count")
  await clean(manager)
  rmSync(state, { recursive: true, force: true })
})

function readdirSafe(directory: string): string[] {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

function safeRead(file: string): Buffer {
  try {
    return readFileSync(file)
  } catch {
    return Buffer.alloc(0)
  }
}
