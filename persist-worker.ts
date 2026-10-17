/**
 * Persistence worker: the ONLY place this plugin touches SQLite, the
 * filesystem, or zlib. The OpenCode server runs plugins under Bun, whose
 * sqlite drivers are synchronous-only - every statement here would block the
 * server's event loop if it ran on the main thread. The main-thread manager
 * (persist.ts) therefore only enqueues O(1) dirty marks and posts plain
 * objects; this worker serializes, gzip-compresses, and writes them inside
 * WAL transactions.
 *
 * Crash consistency: WAL journal + synchronous=NORMAL + one transaction per
 * flush (batched upserts + maintenance commit or roll back atomically; a
 * power loss can drop the most recent un-checkpointed transactions but never
 * corrupts committed state).
 *
 * Concurrent-writer safety: each location's plugin instance runs its own
 * worker against the same database file; WAL plus a bounded busy_timeout
 * serializes overlapping writers (a location reload's old/new instances),
 * and every session upsert is guarded by the session's ACTIVITY timestamp,
 * so a late flush from an old instance can never clobber rows written by
 * its replacement. Usage columns additionally update only when the incoming
 * cumulative event is at least as fresh (replace-not-sum across restarts).
 *
 * Privacy: rows contain aggregate metadata only (keys/sizes/counts/
 * estimates plus the already content-free Analysis snapshots, compressed).
 * Driver errors never leave this file as text - they are mapped to the
 * fixed PERSIST_ERROR_CODES vocabulary.
 *
 * Own data only: this database is the plugin's own file; OpenCode's own
 * database (opencode.db) is never opened. Retention deletes are scoped to
 * this schema's rows exclusively.
 */
import { chmodSync, mkdirSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import { parentPort } from "node:worker_threads"
import { gzipSync, gunzipSync } from "node:zlib"
import type { PersistErrorCode } from "./error-codes.ts"
import { buildGlobalStats, type StatsLocationRow, type StatsSessionRow } from "./persist-stats.ts"
import type {
  PersistBudgets,
  PersistFlushRow,
  PersistHealthResult,
  PersistHydrateResult,
  PersistInitResult,
  PersistFlushResult,
  PersistLocation,
  PersistRequest,
  PersistResponse,
} from "./persist-protocol.ts"
import type { GlobalStatsPayload } from "./types.ts"

const port = parentPort
if (port === null) throw new Error("persist-worker requires a parent port")

// ---------------------------------------------------------------------------
// SQLite engine loading: bun:sqlite (host runtime), node:sqlite fallback.
// ---------------------------------------------------------------------------

interface Statement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}
interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}
type Engine = "bun:sqlite" | "node:sqlite"
type SqliteFactory = (path: string) => { db: Database; engine: Engine }

let sqliteFactory: SqliteFactory | undefined

async function loadSqliteFactory(): Promise<void> {
  const bun = (await import("bun:sqlite").catch(() => undefined)) as { Database: new (path: string) => Database } | undefined
  if (bun !== undefined) {
    sqliteFactory = path => ({ db: new bun.Database(path), engine: "bun:sqlite" })
    return
  }
  const node = (await import("node:sqlite").catch(() => undefined)) as { DatabaseSync: new (path: string) => Database } | undefined
  if (node !== undefined) {
    sqliteFactory = path => ({ db: new node.DatabaseSync(path), engine: "node:sqlite" })
  }
}

/** bun:sqlite's query() caches statements; keep a cache for node:sqlite too so flush loops reuse them. */
const statements = new Map<string, Statement>()
function stmt(sql: string): Statement {
  if (db === undefined) throw new Error("not initialized")
  let cached = statements.get(sql)
  if (cached === undefined) {
    cached = db.prepare(sql)
    statements.set(sql, cached)
  }
  return cached
}

// ---------------------------------------------------------------------------
// Schema (own tables only)
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "1"

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS location (
  key TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  workspace_id TEXT,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  location_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_variant TEXT,
  first_captured_at INTEGER NOT NULL,
  last_captured_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  snapshot_count INTEGER NOT NULL,
  hook_error_count INTEGER NOT NULL,
  last_error_code TEXT,
  last_error_at INTEGER,
  latest_estimated_input_tokens INTEGER NOT NULL,
  latest_system_tokens INTEGER NOT NULL,
  latest_message_tokens INTEGER NOT NULL,
  latest_tool_tokens INTEGER NOT NULL,
  latest_message_count INTEGER NOT NULL,
  peak_estimated_input_tokens INTEGER NOT NULL,
  usage_input INTEGER,
  usage_output INTEGER,
  usage_reasoning INTEGER,
  usage_cache_read INTEGER,
  usage_cache_write INTEGER,
  usage_captured_at INTEGER,
  tools_json TEXT,
  payload BLOB NOT NULL,
  payload_bytes INTEGER NOT NULL,
  raw_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (location_key, session_id)
);
CREATE INDEX IF NOT EXISTS session_active_idx ON session (last_active_at);
CREATE INDEX IF NOT EXISTS session_model_idx ON session (model_provider, model_id);
`

const SESSION_COLUMNS = [
  "location_key", "session_id", "agent", "model_provider", "model_id", "model_variant",
  "first_captured_at", "last_captured_at", "last_active_at", "snapshot_count",
  "hook_error_count", "last_error_code", "last_error_at",
  "latest_estimated_input_tokens", "latest_system_tokens", "latest_message_tokens", "latest_tool_tokens", "latest_message_count",
  "peak_estimated_input_tokens",
  "usage_input", "usage_output", "usage_reasoning", "usage_cache_read", "usage_cache_write", "usage_captured_at",
  "tools_json", "payload", "payload_bytes", "raw_bytes", "updated_at",
] as const

const USAGE_GUARD =
  "excluded.usage_captured_at IS NOT NULL AND (session.usage_captured_at IS NULL OR excluded.usage_captured_at >= session.usage_captured_at)"

const UPSERT_SESSION = `INSERT INTO session (${SESSION_COLUMNS.join(", ")}) VALUES (${SESSION_COLUMNS.map(() => "?").join(", ")})
ON CONFLICT (location_key, session_id) DO UPDATE SET
  agent = excluded.agent,
  model_provider = excluded.model_provider,
  model_id = excluded.model_id,
  model_variant = excluded.model_variant,
  first_captured_at = excluded.first_captured_at,
  last_captured_at = excluded.last_captured_at,
  last_active_at = excluded.last_active_at,
  snapshot_count = excluded.snapshot_count,
  hook_error_count = excluded.hook_error_count,
  last_error_code = excluded.last_error_code,
  last_error_at = excluded.last_error_at,
  latest_estimated_input_tokens = excluded.latest_estimated_input_tokens,
  latest_system_tokens = excluded.latest_system_tokens,
  latest_message_tokens = excluded.latest_message_tokens,
  latest_tool_tokens = excluded.latest_tool_tokens,
  latest_message_count = excluded.latest_message_count,
  peak_estimated_input_tokens = excluded.peak_estimated_input_tokens,
  usage_input = CASE WHEN ${USAGE_GUARD} THEN excluded.usage_input ELSE session.usage_input END,
  usage_output = CASE WHEN ${USAGE_GUARD} THEN excluded.usage_output ELSE session.usage_output END,
  usage_reasoning = CASE WHEN ${USAGE_GUARD} THEN excluded.usage_reasoning ELSE session.usage_reasoning END,
  usage_cache_read = CASE WHEN ${USAGE_GUARD} THEN excluded.usage_cache_read ELSE session.usage_cache_read END,
  usage_cache_write = CASE WHEN ${USAGE_GUARD} THEN excluded.usage_cache_write ELSE session.usage_cache_write END,
  usage_captured_at = CASE WHEN ${USAGE_GUARD} THEN excluded.usage_captured_at ELSE session.usage_captured_at END,
  tools_json = excluded.tools_json,
  payload = excluded.payload,
  payload_bytes = excluded.payload_bytes,
  raw_bytes = excluded.raw_bytes,
  updated_at = excluded.updated_at
WHERE excluded.updated_at >= session.updated_at`

const UPSERT_LOCATION =
  "INSERT INTO location (key, directory, workspace_id, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET directory = excluded.directory, workspace_id = excluded.workspace_id, last_seen_at = excluded.last_seen_at"

const HYDRATE_SQL =
  "SELECT session_id, last_active_at, payload FROM session WHERE location_key = ? ORDER BY last_active_at DESC, session_id LIMIT ?"

const STATS_TOTALS_SQL =
  "SELECT COUNT(DISTINCT location_key) AS locations, IFNULL(SUM(payload_bytes), 0) AS payloadBytes, IFNULL(SUM(raw_bytes), 0) AS rawBytes FROM session"

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let db: Database | undefined
let dbPath = ""
let engine: Engine | "none" = "none"
let recoveredFromCorruption = false
let budgets: PersistBudgets = { maxSessionsPerLocation: 50, maxAgeMs: 30 * 24 * 60 * 60 * 1000, byteBudgetBytes: 32 * 1024 * 1024 }
let location: PersistLocation = { key: "", directory: "" }
let lastMaintenanceAt = 0
let lastMaintenanceDeleted = 0
let lastVacuumAt = 0
const VACUUM_INTERVAL_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reply(response: PersistResponse): void {
  port?.postMessage(response)
}

function fail(id: number, code: PersistErrorCode): void {
  reply({ id, ok: false, code })
}

function classify(error: unknown, fallback: PersistErrorCode): PersistErrorCode {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("SQLITE_BUSY") || message.includes("database is locked")) return "busy-timeout"
  if (message.includes("not a database") || message.includes("malformed") || message.includes("corrupt")) return "db-corrupt"
  if (
    message.includes("not a directory") ||
    message.includes("EACCES") ||
    message.includes("EPERM") ||
    message.includes("EROFS") ||
    message.includes("ENOSPC") ||
    message.includes("EISDIR")
  ) {
    return "db-open-failed"
  }
  return fallback
}

function changes(result: unknown): number {
  if (typeof result === "object" && result !== null) {
    const value = (result as { changes?: unknown }).changes
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return 0
}

function int(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

/** Compact latest-snapshot tool ranking for global aggregation (metadata only, bounded). */
const MAX_TOOL_ENTRIES = 25
function toolsJsonFor(snapshots: readonly unknown[]): string | null {
  const latest = snapshots[snapshots.length - 1]
  if (typeof latest !== "object" || latest === null) return null
  const tools = (latest as { tools?: unknown }).tools
  if (typeof tools !== "object" || tools === null) return null
  const schema: unknown[][] = []
  const ranked = (tools as { ranked?: unknown }).ranked
  if (Array.isArray(ranked)) {
    for (const tool of ranked.slice(0, MAX_TOOL_ENTRIES)) {
      if (typeof tool === "object" && tool !== null) {
        const t = tool as { id?: unknown; estimatedTokens?: unknown }
        if (typeof t.id === "string") schema.push([t.id, int(t.estimatedTokens)])
      }
    }
  }
  const io: unknown[][] = []
  const ioRanked = ((tools as { io?: unknown }).io as { ranked?: unknown } | undefined)?.ranked
  if (Array.isArray(ioRanked)) {
    for (const entry of ioRanked.slice(0, MAX_TOOL_ENTRIES)) {
      if (typeof entry === "object" && entry !== null) {
        const e = entry as { name?: unknown; calls?: unknown; results?: unknown; estimatedTokens?: unknown }
        if (typeof e.name === "string") io.push([e.name, int(e.calls), int(e.results), int(e.estimatedTokens)])
      }
    }
  }
  return JSON.stringify({ s: schema, io })
}

interface DerivedRow {
  readonly values: unknown[]
  readonly rawBytes: number
  readonly compressedBytes: number
}

function deriveSessionRow(row: PersistFlushRow, now: number): DerivedRow {
  const snapshots = Array.isArray(row.record.snapshots) ? row.record.snapshots : []
  const latest = snapshots[snapshots.length - 1] as
    | { agent?: unknown; model?: { providerID?: unknown; id?: unknown; variant?: unknown }; totals?: Record<string, unknown>; messages?: { total?: unknown } }
    | undefined
  const errors = row.record.errors ?? { count: 0 }
  let peak = 0
  let firstCapturedAt = 0
  let lastCapturedAt = 0
  for (const snapshot of snapshots) {
    const tokens = int((snapshot as { totals?: { estimatedInputTokens?: unknown } } | undefined)?.totals?.estimatedInputTokens)
    if (tokens > peak) peak = tokens
    const capturedAt = int((snapshot as { capturedAt?: unknown } | undefined)?.capturedAt)
    if (capturedAt > 0 && (firstCapturedAt === 0 || capturedAt < firstCapturedAt)) firstCapturedAt = capturedAt
    if (capturedAt > lastCapturedAt) lastCapturedAt = capturedAt
  }
  const usage = row.usage
  // The conflict guard uses the session's ACTIVITY instant (snapshot/error/
  // usage activity), never the write time: a stale flush from an old plugin
  // instance then loses against rows written by the newer instance.
  const updatedAt = Math.max(int(row.lastActiveAt), int(errors.lastAt), lastCapturedAt, usage ? int(usage.capturedAt) : 0)
  const raw = JSON.stringify({ v: 1, snapshots, errors })
  const compressed = gzipSync(Buffer.from(raw, "utf8"))
  const values: unknown[] = [
    location.key,
    row.sessionID,
    str(latest?.agent),
    str(latest?.model?.providerID),
    str(latest?.model?.id),
    typeof latest?.model?.variant === "string" ? latest.model.variant : null,
    firstCapturedAt,
    lastCapturedAt,
    int(row.lastActiveAt, now),
    snapshots.length,
    int(errors.count),
    typeof errors.lastCode === "string" ? errors.lastCode : null,
    typeof errors.lastAt === "number" ? errors.lastAt : null,
    int(latest?.totals?.estimatedInputTokens),
    int(latest?.totals?.systemTokens),
    int(latest?.totals?.messageTokens),
    int(latest?.totals?.toolTokens),
    int(latest?.messages?.total),
    peak,
    usage ? usage.input : null,
    usage ? usage.output : null,
    usage ? usage.reasoning : null,
    usage ? usage.cacheRead : null,
    usage ? usage.cacheWrite : null,
    usage ? usage.capturedAt : null,
    toolsJsonFor(snapshots),
    compressed,
    compressed.byteLength,
    Buffer.byteLength(raw, "utf8"),
    updatedAt,
  ]
  return { values, rawBytes: Buffer.byteLength(raw, "utf8"), compressedBytes: compressed.byteLength }
}

function fileBytes(): number {
  let total = 0
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(dbPath + suffix).size
    } catch {
      // Optional files (fresh WAL, checkpointed) may not exist.
    }
  }
  return total
}

/** Retention enforcement (own rows only): age, per-location cap, global byte budget. */
function maintenanceDeleted(now: number): number {
  let deleted = 0
  deleted += changes(stmt("DELETE FROM session WHERE last_active_at < ?").run(now - budgets.maxAgeMs))
  deleted += changes(
    stmt(
      `DELETE FROM session WHERE session_id IN (
        SELECT session_id FROM session WHERE location_key = ? ORDER BY last_active_at DESC, session_id LIMIT -1 OFFSET ?
      )`,
    ).run(location.key, budgets.maxSessionsPerLocation),
  )
  // Global byte budget: evict least-recently-active rows ONE at a time so
  // the total converges near the budget instead of overshooting to zero.
  for (let i = 0; i < 500; i++) {
    const total = int((stmt("SELECT IFNULL(SUM(payload_bytes), 0) AS c FROM session").get() as { c?: number } | undefined)?.c)
    if (total <= budgets.byteBudgetBytes) break
    const chunk = changes(
      stmt("DELETE FROM session WHERE session_id IN (SELECT session_id FROM session ORDER BY last_active_at ASC, session_id LIMIT 1)").run(),
    )
    deleted += chunk
    if (chunk === 0) break
  }
  stmt("DELETE FROM location WHERE key NOT IN (SELECT DISTINCT location_key FROM session)").run()
  return deleted
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

function initialize(request: { dbDirectory: string; location: PersistLocation; budgets: PersistBudgets }): PersistInitResult {
  if (sqliteFactory === undefined) {
    const error = new Error("no sqlite engine")
    error.name = "DbOpenFailed"
    throw error
  }
  budgets = request.budgets
  location = request.location
  mkdirSync(request.dbDirectory, { recursive: true })
  try {
    chmodSync(request.dbDirectory, 0o700)
  } catch {
    // Best effort (some filesystems reject chmod).
  }
  dbPath = join(request.dbDirectory, "context-doctor.db")
  recoveredFromCorruption = false
  for (let attempt = 0; attempt < 2; attempt++) {
    const opened = sqliteFactory(dbPath)
    let candidate: Database | undefined = opened.db
    try {
      // busy_timeout FIRST: converting the journal mode takes a write lock,
      // and a concurrent worker's init must wait rather than fail fast.
      candidate.exec("PRAGMA busy_timeout = 1500")
      for (let pragmaAttempt = 0; pragmaAttempt < 4; pragmaAttempt += 1) {
        try {
          candidate.exec("PRAGMA journal_mode = WAL")
          break
        } catch (error) {
          if (pragmaAttempt === 3 || classify(error, "init-failed") !== "busy-timeout") throw error
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + pragmaAttempt * 50)
        }
      }
      candidate.exec("PRAGMA synchronous = NORMAL")
      candidate.exec("PRAGMA auto_vacuum = INCREMENTAL")
      candidate.exec(DDL)
      candidate.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION)
      try {
        chmodSync(dbPath, 0o600)
      } catch {
        // Best effort.
      }
      db = candidate
      engine = opened.engine
      return {
        dbPath,
        engine: opened.engine,
        recoveredFromCorruption,
        schemaVersion: Number.parseInt(SCHEMA_VERSION, 10),
      }
    } catch (error) {
      try {
        candidate.close()
      } catch {
        // Already closed.
      }
      candidate = undefined
      if (classify(error, "init-failed") === "db-corrupt" && attempt === 0) {
        // Own file only: move the unreadable database aside and start fresh.
        try {
          renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`)
          recoveredFromCorruption = true
          statements.clear()
          continue
        } catch {
          throw error
        }
      }
      throw error
    }
  }
  throw new Error("unreachable")
}

function handleFlush(request: { sessions: readonly PersistFlushRow[]; maintenance: boolean }): PersistFlushResult {
  if (db === undefined) throw new Error("not initialized")
  const now = Date.now()
  let rawBytes = 0
  let compressedBytes = 0
  let written = 0
  let deleted = 0
  const ranMaintenance = request.maintenance
  db.exec("BEGIN IMMEDIATE")
  try {
    const locationStmt = stmt(UPSERT_LOCATION)
    const sessionStmt = stmt(UPSERT_SESSION)
    for (const row of request.sessions) {
      if (typeof row.sessionID !== "string" || row.sessionID.length === 0) continue
      locationStmt.run(location.key, location.directory, location.workspaceID ?? null, now)
      const derived = deriveSessionRow(row, now)
      rawBytes += derived.rawBytes
      compressedBytes += derived.compressedBytes
      sessionStmt.run(...derived.values)
      written += 1
    }
    if (ranMaintenance) {
      deleted = maintenanceDeleted(now)
      if (now - lastVacuumAt > VACUUM_INTERVAL_MS) {
        db.exec("PRAGMA incremental_vacuum(64)")
        lastVacuumAt = now
      }
      lastMaintenanceAt = now
      lastMaintenanceDeleted = deleted
    }
    db.exec("COMMIT")
    return { written, rawBytes, compressedBytes, maintenanceRan: ranMaintenance, deletedByMaintenance: deleted }
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // Connection already rolled back.
    }
    throw error
  }
}

function handleHydrate(request: { locationKey: string }): PersistHydrateResult {
  if (db === undefined) throw new Error("not initialized")
  const rows = stmt(HYDRATE_SQL).all(request.locationKey, budgets.maxSessionsPerLocation) as unknown[]
  const sessions: import("./persist-protocol.ts").PersistHydratedSession[] = []
  let skipped = 0
  for (const raw of rows) {
    const row = raw as { session_id?: unknown; last_active_at?: unknown; payload?: unknown }
    const sessionID = str(row.session_id)
    if (sessionID.length === 0) {
      skipped += 1
      continue
    }
    try {
      const blob = row.payload instanceof Uint8Array ? row.payload : new Uint8Array(row.payload as ArrayBuffer)
      const parsed = JSON.parse(gunzipSync(Buffer.from(blob)).toString("utf8")) as {
        snapshots?: unknown
        errors?: { count?: unknown; lastAt?: unknown; lastCode?: unknown }
      }
      if (!Array.isArray(parsed.snapshots)) {
        skipped += 1
        continue
      }
      sessions.push({
        sessionID,
        lastActiveAt: int(row.last_active_at),
        snapshots: parsed.snapshots,
        errors: {
          count: int(parsed.errors?.count),
          ...(typeof parsed.errors?.lastAt === "number" ? { lastAt: parsed.errors.lastAt } : {}),
          ...(typeof parsed.errors?.lastCode === "string" ? { lastCode: parsed.errors.lastCode } : {}),
        },
      })
    } catch {
      skipped += 1
    }
  }
  return { sessions, skipped }
}

function handleHealth(): PersistHealthResult {
  if (db === undefined) throw new Error("not initialized")
  const totals = stmt(
    "SELECT COUNT(DISTINCT location_key) AS locations, COUNT(*) AS sessions, IFNULL(SUM(snapshot_count), 0) AS snapshots, IFNULL(SUM(payload_bytes), 0) AS payloadBytes, IFNULL(SUM(raw_bytes), 0) AS rawBytes FROM session",
  ).get() as Record<string, number> | undefined
  return {
    dbPath,
    engine,
    fileBytes: fileBytes(),
    locations: int(totals?.locations),
    sessions: int(totals?.sessions),
    snapshots: int(totals?.snapshots),
    payloadBytes: int(totals?.payloadBytes),
    rawBytes: int(totals?.rawBytes),
    ...(lastMaintenanceAt > 0 ? { lastMaintenanceAt } : {}),
    ...(lastMaintenanceDeleted > 0 ? { lastMaintenanceDeleted } : {}),
  }
}

function handleGlobalStats(topN: number): GlobalStatsPayload {
  if (db === undefined) throw new Error("not initialized")
  const sessionRows = stmt(
    "SELECT location_key, session_id, agent, model_provider, model_id, model_variant, first_captured_at, last_captured_at, last_active_at, snapshot_count, latest_estimated_input_tokens, peak_estimated_input_tokens, usage_input, usage_output, usage_reasoning, usage_cache_read, usage_cache_write, usage_captured_at, tools_json FROM session",
  ).all() as unknown as StatsSessionRow[]
  const locationRows = stmt(
    `SELECT l.key AS key, l.directory AS directory, l.workspace_id AS workspace_id, COUNT(*) AS sessions, IFNULL(SUM(s.snapshot_count), 0) AS snapshots, MAX(s.last_active_at) AS lastActiveAt
     FROM location l JOIN session s ON s.location_key = l.key GROUP BY l.key ORDER BY lastActiveAt DESC LIMIT 50`,
  ).all() as unknown as StatsLocationRow[]
  const totals = stmt(STATS_TOTALS_SQL).get() as Record<string, number> | undefined
  const directoryOfSession = new Map(
    sessionRows.map(row => [row.session_id, locationRows.find(l => l.key === row.location_key)?.directory ?? ""]),
  )
  return buildGlobalStats(sessionRows, {
    topN,
    budgets,
    generatedAt: Date.now(),
    locationCount: int(totals?.locations),
    payloadBytes: int(totals?.payloadBytes),
    rawBytes: int(totals?.rawBytes),
    directoryOfSession,
    locations: locationRows.map(row => ({
      directory: row.directory,
      ...(row.workspace_id !== null && row.workspace_id !== undefined ? { workspaceID: row.workspace_id } : {}),
      sessions: int(row.sessions),
      snapshots: int(row.snapshots),
      lastActiveAt: int(row.lastActiveAt),
    })),
  })
}

// ---------------------------------------------------------------------------
// FIFO message loop (strictly serial: preserves per-session write ordering)
// ---------------------------------------------------------------------------

const queue: PersistRequest[] = []
let draining = false

port.on("message", (request: PersistRequest) => {
  queue.push(request)
  void drain()
})

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (queue.length > 0) {
      const request = queue.shift()!
      try {
        if (request.kind === "init") {
          if (sqliteFactory === undefined) await loadSqliteFactory()
          const result = initialize(request)
          reply({ id: request.id, ok: true, kind: "init", result })
          continue
        }
        if (db === undefined) {
          fail(request.id, "init-failed")
          continue
        }
        switch (request.kind) {
          case "hydrate":
            reply({ id: request.id, ok: true, kind: "hydrate", result: handleHydrate(request) })
            break
          case "flush": {
            const result = handleFlush(request)
            reply({ id: request.id, ok: true, kind: "flush", result })
            break
          }
          case "globalStats": {
            const result = handleGlobalStats(request.topN)
            reply({ id: request.id, ok: true, kind: "globalStats", result })
            break
          }
          case "health":
            reply({ id: request.id, ok: true, kind: "health", result: handleHealth() })
            break
        }
      } catch (error) {
        const fallback: PersistErrorCode =
          request.kind === "flush"
            ? "flush-failed"
            : request.kind === "hydrate"
              ? "hydrate-failed"
              : request.kind === "init"
                ? "init-failed"
                : "query-failed"
        fail(request.id, classify(error, fallback))
      }
    }
  } finally {
    draining = false
  }
}
