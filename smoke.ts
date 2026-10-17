/**
 * Standalone V2 smoke check - run with: bun smoke.ts
 *
 * Loads the plugin exactly as a module (the real "@opencode/plugin" runtime:
 * Plugin.define and Rpc.define execute at import time), drives one context
 * hook observation and both RPC methods against an in-memory harness, and
 * verifies cleanup. No OpenCode config is read or written, no server is
 * started, and no model calls are made.
 */
import { Plugin } from "@opencode/plugin"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin from "./index.ts"
import { ContextDoctor } from "./rpc.ts"
import { fixtureEvent, fixtureModels, fixtureSessionMessages } from "./fixtures.ts"
import { formatReportLines } from "./format.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SMOKE FAILED: ${message}`)
}

const emitted: { name: string; data: unknown }[] = []
let hookCallback: ((event: unknown) => void) | undefined
let rpcHandlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {}
const disposed: string[] = []

const eventQueue: unknown[] = []
let wake: (() => void) | undefined
const eventStream: AsyncIterable<unknown> = {
  [Symbol.asyncIterator]() {
    return {
      async next() {
        if (eventQueue.length > 0) return { value: eventQueue.shift(), done: false }
        await new Promise<void>(resolve => {
          wake = resolve
        })
        if (eventQueue.length > 0) return { value: eventQueue.shift(), done: false }
        return { value: undefined, done: true }
      },
    }
  },
}

const ctx = {
  app: { version: "2.0.30-smoke", channel: "stable" },
  location: { directory: "/smoke/project", project: { id: "smoke", directory: "/smoke/project", canonical: "/smoke/project" } },
  options: { storageDirectory: mkdtempSync(path.join(tmpdir(), "context-doctor-smoke-")) },
  mcp: { list: async () => ({ location: { directory: "/smoke/project" }, data: [{ name: "github", status: { status: "connected" } }] }) },
  model: { list: async () => ({ location: { directory: "/smoke/project" }, data: fixtureModels() }) },
  session: {
    context: async () => fixtureSessionMessages(),
    hook: async (name: string, callback: (event: unknown) => void) => {
      assert(name === "context", `unexpected hook ${name}`)
      hookCallback = callback
      return { dispose: async () => disposed.push("hook") }
    },
  },
  rpc: {
    register: async (definition: unknown, handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>) => {
      assert((definition as { id: string }).id === ContextDoctor.id, "rpc id mismatch")
      rpcHandlers = handlers
      return {
        dispose: async () => disposed.push("rpc"),
        events: { emit: async (name: string, data: unknown) => void emitted.push({ name, data }) },
      }
    },
  },
  event: { subscribe: () => eventStream },
}

const callContext = { signal: new AbortController().signal, error: (type: string, message: string, data?: unknown) => ({ type, message, data }) }

async function main(): Promise<void> {
  assert(typeof Plugin.define === "function", "@opencode/plugin runtime loaded")

  const cleanup = (await plugin.setup(ctx as never)) as () => void | Promise<void>
  assert(typeof hookCallback === "function", "context hook registered")
  assert(
    typeof rpcHandlers.list === "function" && typeof rpcHandlers.report === "function" && typeof rpcHandlers.diagnostics === "function" && typeof rpcHandlers.stats === "function",
    "rpc methods registered",
  )

  // FIRST-capture failure on a fresh session: must be visible, never dropped.
  const poisoned = fixtureEvent({ sessionID: "ses_boom" }) as unknown as Record<string, unknown>
  Object.defineProperty(poisoned, "system", {
    get() {
      throw new Error("first capture exploded")
    },
  })
  hookCallback!(poisoned)
  let diag = (await rpcHandlers.diagnostics!({}, callContext)) as { hookInvocations: number; capturesStored: number; captureFailures: number; sessionsWithErrorOnly: number; instanceDirectory: string }
  assert(diag.hookInvocations === 1 && diag.capturesStored === 0 && diag.captureFailures === 1, "first-capture failure counted")
  assert(diag.sessionsWithErrorOnly === 1 && diag.instanceDirectory === "/smoke/project", "error-only session and instance location exposed")
  const boom = (await rpcHandlers.report!({ sessionID: "ses_boom" }, callContext)) as { type: string; data: { reason: string; hookErrorCount: number } }
  assert(boom.type === "unknown_session" && boom.data.reason === "hook_error" && boom.data.hookErrorCount === 1, "typed hook_error reason for failed session")

  const event = fixtureEvent()
  const before = JSON.stringify(event)
  hookCallback!(event)
  assert(JSON.stringify(event) === before, "hook observation is non-mutating")
  assert(emitted.length === 1 && (emitted[0]!.data as { estimatedInputTokens: number }).estimatedInputTokens > 0, "captured event emitted")

  const list = (await rpcHandlers.list!({}, callContext)) as { sessions: { sessionID: string }[] }
  assert(list.sessions.length === 1 && list.sessions[0]!.sessionID === "ses_test", "rpc list returns the tracked session")

  const errorCase = (await rpcHandlers.report!({ sessionID: "ses_none" }, callContext)) as { type: string }
  assert(errorCase.type === "unknown_session", "typed unknown_session error")

  const report = (await rpcHandlers.report!({ sessionID: "ses_test" }, callContext)) as {
    totals: { estimatedInputTokens: number }
    reported: { cumulative: { source: string } }
    tools: { ranked: { id: string; group: { name: string } }[] }
  }
  assert(report.totals.estimatedInputTokens > 0, "report has estimates")
  assert(report.reported.cumulative.source === "session.context-sum", "reported usage resolved")
  assert(report.tools.ranked.some(t => t.id === "github_create_issue" && t.group.name === "github"), "mcp grouping applied")

  const lines = formatReportLines(report as never)
  assert(lines.length > 20 && !lines.join("\n").includes("undefined"), "report renders")

  // Same-location cumulative usage event is applied (replace, not sum).
  eventQueue.push({ type: "session.usage.updated", created: 99, location: { directory: "/smoke/project" }, data: { sessionID: "ses_test", tokens: { input: 5_000, output: 10, cache: { read: 0, write: 0 } } } })
  wake?.()
  await new Promise(resolve => setTimeout(resolve, 20))
  const updated = (await rpcHandlers.report!({ sessionID: "ses_test" }, callContext)) as { reported: { cumulative: { tokens: { input: number } } } }
  assert(updated.reported.cumulative.tokens.input === 5_000, "live usage event applied")

  const diag2 = (await rpcHandlers.diagnostics!({}, callContext)) as { hookInvocations: number; capturesStored: number; captureFailures: number; sessionsWithSnapshots: number; persistence?: { status: string } }
  assert(diag2.hookInvocations === 2 && diag2.capturesStored === 1 && diag2.captureFailures === 1 && diag2.sessionsWithSnapshots === 1, "diagnostics counters reconcile")

  await cleanup()
  assert(disposed.includes("hook") && disposed.includes("rpc"), "cleanup disposes registrations")

  // Persistence roundtrip: a second plugin instance on the same state
  // directory must hydrate the flushed snapshot (plugin-reload equivalent).
  const secondSetup = (await plugin.setup(ctx as never)) as () => void | Promise<void>
  for (let i = 0; i < 500; i += 1) {
    const probe = (await rpcHandlers.diagnostics!({}, callContext)) as { persistence?: { status?: string; hydratedSessions?: number } }
    if (probe.persistence?.status === "active" && (probe.persistence?.hydratedSessions ?? 0) > 0) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const hydrated = (await rpcHandlers.diagnostics!({}, callContext)) as { persistence?: { status: string; hydratedSessions: number; dbPath?: string; retention?: { byteBudgetBytes: number } } }
  assert(hydrated.persistence?.status === "active", "persistence active")
  assert((hydrated.persistence?.hydratedSessions ?? 0) >= 1, "snapshot survived the reload-equivalent restart")
  assert(typeof hydrated.persistence?.dbPath === "string" && hydrated.persistence.dbPath.includes("context-doctor-smoke"), "own state directory reported")
  const stats = (await rpcHandlers.stats!({ topN: 5 }, callContext)) as { available: boolean; totals: { sessions: number } }
  assert(stats.available === true && stats.totals.sessions >= 1, "cross-location stats answer from persisted rows")
  await secondSetup()
  rmSync((ctx.options as { storageDirectory: string }).storageDirectory, { recursive: true, force: true })

  console.log("SMOKE_OK: plugin loaded, hook observed non-mutatingly, list + report + typed errors + usage event + persistence roundtrip + stats + cleanup all verified")
}

void main().catch(error => {
  console.error("SMOKE_FAILED:", error instanceof Error ? error.message : error)
  process.exitCode = 1
})
