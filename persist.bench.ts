/**
 * Honest persistence-overhead benchmark. Run: bun persist.bench.ts
 *
 * Measures, on this host and runtime (Bun worker + bun:sqlite + gzip):
 *  1. context-hook path: analysis+store only (baseline) vs analysis+store+the
 *     persistence enqueue (markDirty) - p50/p95/max. The hook NEVER awaits
 *     disk, compression, or SQLite; enqueue work must be O(1) bookkeeping.
 *  2. enqueue cost vs history depth (1 vs 20 retained snapshots) - proves no
 *     O(history) serialization happens per capture.
 *  3. end-to-end flush latency for a fully dirty store (50 sessions x 20
 *     snapshots) - off the hook path, in the worker.
 *  4. on-disk size: raw JSON vs compressed payload vs database file, plus the
 *     measured compression ratio.
 *
 * No accuracy claims are made beyond what is printed; numbers are
 * wall-clock medians/percentiles of this run, not guarantees.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { analyzeContextEvent } from "./analytics.ts"
import { createPersistence } from "./persist.ts"
import { createSnapshotStore } from "./store.ts"
import type { ContextEventLike } from "./analytics.ts"

// ---------------------------------------------------------------------------
// Representative payload: 175 messages (mixed parts incl. tool I/O) + a large
// per-request tool snapshot (40 tools with realistic schema sizes).
// ---------------------------------------------------------------------------

function textBlock(characters: number, seed: number): string {
  const words = ["path", "config", "schema", "value", "cache", "token", "message", "context", "estimate", "aggregate"]
  let out = ""
  let i = seed
  while (out.length < characters) {
    out += words[i % words.length]! + " "
    i += 1
  }
  return out.slice(0, characters)
}

function jsonSchemaProperties(count: number, seed: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (let i = 0; i < count; i += 1) {
    properties[`property_${seed}_${i}`] = {
      type: i % 3 === 0 ? "string" : i % 3 === 1 ? "number" : "boolean",
      description: textBlock(160, seed + i),
    }
  }
  return properties
}

function representativeEvent(sessionID: string, variant = 0): ContextEventLike {
  const messages: unknown[] = []
  // Snapshots must differ in the content-free analysis (lengths), not just text.
  const grow = variant * 3
  for (let i = 0; i < 175; i += 1) {
    const role = i % 5 === 0 ? "user" : i % 5 === 1 ? "assistant" : i % 5 === 2 ? "tool" : i % 5 === 3 ? "user" : "assistant"
    if (role === "assistant") {
      messages.push({
        role,
        content: [
          { type: "reasoning", text: textBlock(400 + grow, i + variant) },
          { type: "text", text: textBlock(900 + grow, i + 7 + variant) },
          { type: "tool-call", id: `call_${i}`, name: "read", input: { path: `/src/module_${i}.ts` } },
        ],
      } as never)
    } else if (role === "tool") {
      messages.push({
        role,
        content: [{ type: "tool-result", id: `call_${i - 1}`, name: "read", result: { type: "text", value: textBlock(1400 + grow, i + variant) } }],
      } as never)
    } else {
      messages.push({ role, content: [{ type: "text", text: textBlock(1100 + grow, i + variant) }] } as never)
    }
  }
  const tools: Record<string, { description: string; input: unknown }> = {}
  for (let i = 0; i < 40; i += 1) {
    tools[`tool_${i}`] = {
      description: textBlock(320, i),
      input: { type: "object", properties: jsonSchemaProperties(24, i), required: ["property_" + i + "_0"] },
    }
  }
  return {
    sessionID,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    system: [{ type: "text", text: textBlock(24_000, 3) }, { type: "text", text: textBlock(8_000, 9) }],
    messages: messages as ContextEventLike["messages"],
    tools,
  }
}

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

interface Stats {
  readonly p50: number
  readonly p95: number
  readonly max: number
  readonly mean: number
}

function summarize(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
  return {
    p50: at(50),
    p95: at(95),
    max: sorted[sorted.length - 1]!,
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  }
}

const fmt = (ms: number) => `${ms >= 100 ? ms.toFixed(1) : ms.toFixed(3)} ms`
const bytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`)

function row(label: string, stats: Stats): string {
  return `  ${label.padEnd(46)} p50 ${fmt(stats.p50).padStart(10)}   p95 ${fmt(stats.p95).padStart(10)}   max ${fmt(stats.max).padStart(10)}   mean ${fmt(stats.mean).padStart(10)}`
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const state = mkdtempSync(path.join(tmpdir(), "context-doctor-bench-"))
  const budgets = { maxSessionsPerLocation: 50, maxAgeMs: 30 * 24 * 60 * 60 * 1000, byteBudgetBytes: 32 * 1024 * 1024 }
  const store = createSnapshotStore({ maxSessions: 50, maxSnapshotsPerSession: 20 })
  const persistence = createPersistence(store, {
    directory: "/bench/project",
    storageDirectory: state,
    budgets,
    debounceMs: 3_600_000, // manual flushes only; the timer path is not under test
  })
  for (let i = 0; i < 500; i += 1) {
    if (persistence.health().status !== "pending") break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  if (persistence.health().status !== "active") throw new Error(`persistence not active: ${persistence.health().lastErrorCode}`)

  console.log(`opencode-context-doctor persistence benchmark`)
  console.log(`runtime: bun ${process.versions.bun ?? "?"} · engine ${persistence.health().engine ?? "?"} · ${new Date().toISOString()}`)
  console.log(`payload: 175 messages + 2 system parts (~32k chars) + 40 tool schemas (24 props each)`)
  console.log("")

  // Warm up JIT paths with the representative event.
  const event = representativeEvent("ses_warm")
  for (let i = 0; i < 30; i += 1) analyzeContextEvent(event, { now: () => 1 + i })

  // --- 1. hook path: baseline vs persistence enqueue -----------------------
  const ITERATIONS = 300
  const baseline: number[] = []
  const withEnqueue: number[] = []
  let clock = 1_000
  for (let i = 0; i < ITERATIONS; i += 1) {
    const sessionID = `ses_bench_${i % 50}`
    const candidate = analyzeContextEvent(representativeEvent(sessionID, i), { now: () => clock + i })
    const t0 = performance.now()
    store.record(candidate)
    const t1 = performance.now()
    persistence.markDirty(sessionID)
    const t2 = performance.now()
    baseline.push(t1 - t0)
    withEnqueue.push(t2 - t1)
  }
  console.log("1. context-hook path (store.record baseline vs +markDirty enqueue):")
  console.log(row("store.record (baseline, pre-existing)", summarize(baseline)))
  console.log(row("+ persistence enqueue (markDirty)", summarize(withEnqueue)))
  const enqueue = summarize(withEnqueue)
  console.log(`   persistence adds ~${enqueue.p50.toFixed(4)} ms per capture (markDirty p50; analysis + store.record are unchanged pre-existing work; no disk, serialization, or SQLite on this path)`)
  console.log("")

  // --- 2. enqueue cost vs retained history depth ---------------------------
  console.log("2. enqueue cost vs retained history depth (per-capture work must not scale with history):")
  for (const depth of [1, 20]) {
    const deepStore = createSnapshotStore({ maxSessions: 50, maxSnapshotsPerSession: depth })
    const persistence2 = createPersistence(deepStore, {
      directory: "/bench/depth",
      storageDirectory: state,
      budgets,
      debounceMs: 3_600_000,
    })
    for (let i = 0; i < 500; i += 1) {
      if (persistence2.health().status !== "pending") break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    for (let i = 0; i < depth; i += 1) {
      deepStore.record(analyzeContextEvent(representativeEvent("ses_deep", i), { now: () => 5_000 + i * 10 }))
    }
    const samples: number[] = []
    for (let i = 0; i < 200; i += 1) {
      const candidate = analyzeContextEvent(representativeEvent("ses_deep", depth + i), { now: () => 20_000 + i * 10 })
      deepStore.record(candidate)
      const t0 = performance.now()
      persistence2.markDirty("ses_deep")
      samples.push(performance.now() - t0)
    }
    console.log(row(`markDirty with ${String(depth).padStart(2)} retained snapshot${depth === 1 ? "" : "s"}`, summarize(samples)))
    await persistence2.dispose()
  }
  console.log("")

  // --- 3. end-to-end flush (off the hook path) -----------------------------
  // Fill the store to its bounds: 50 sessions x 20 snapshots, all dirty.
  for (let session = 0; session < 50; session += 1) {
    for (let snap = 0; snap < 20; snap += 1) {
      // Vary content per snapshot: identical re-observations dedupe by design.
      const candidate = analyzeContextEvent(representativeEvent(`ses_full_${session}`, snap), { now: () => 100_000 + snap })
      store.record(candidate)
      persistence.markDirty(`ses_full_${session}`)
    }
  }
  console.log("3. end-to-end flush of the fully dirty store (50 sessions x 20 snapshots each):")
  for (let i = 0; i < 4; i += 1) {
    const t0 = performance.now()
    await persistence.flushNow()
    const elapsed = performance.now() - t0
    const flushed = persistence.health().flushedSessions
    console.log(`   flush ${i + 1}: ${fmt(elapsed)} (cumulative sessions written: ${flushed}, failures: ${persistence.health().flushFailures})`)
    // Re-dirty every session so each iteration measures a full 50x20 write.
    for (let session = 0; session < 50; session += 1) persistence.markDirty(`ses_full_${session}`)
  }
  console.log("")

  // --- 4. on-disk size and compression -------------------------------------
  const health = await persistence.refreshHealth()
  const dbFile = path.join(state, "context-doctor.db")
  let fileTotal = 0
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fileTotal += statSync(dbFile + suffix).size
    } catch {
      // optional
    }
  }
  console.log("4. on-disk footprint (aggregate metadata only, gzip-compressed payloads):")
  console.log(`   sessions on disk: ${health.totals?.sessions ?? 0} · snapshots: ${health.totals?.snapshots ?? 0}`)
  console.log(`   raw JSON payload bytes:   ${bytes(health.totals?.rawBytes ?? 0).padStart(11)}`)
  console.log(`   compressed payload bytes: ${bytes(health.totals?.payloadBytes ?? 0).padStart(11)}`)
  console.log(`   measured compression:     ${((health.totals?.rawBytes ?? 0) / Math.max(1, health.totals?.payloadBytes ?? 1)).toFixed(2)}x (raw / compressed)`)
  console.log(`   database files on disk:   ${bytes(fileTotal).padStart(11)} (db + wal + shm)`)
  console.log("")

  const stats = await persistence.globalStats(10)
  console.log(`global stats sanity: ${stats.totals.sessions} sessions / ${stats.totals.snapshots} snapshots / avg latest ${stats.context.avgLatestEstimatedInputTokens} tok`)

  await persistence.dispose()
  rmSync(state, { recursive: true, force: true })
}

void main().catch(error => {
  console.error("BENCH_FAILED:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
