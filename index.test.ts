import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { McpListOutput, ModelListOutput, SessionMessageInfo } from "@opencode/client"
import plugin, { parseOptions } from "./index.ts"
import { ContextDoctor } from "./rpc.ts"
import type { ReportPayload } from "./types.ts"
import { RAW_SECRET, fixtureEvent, fixtureModels, fixtureSessionMessages } from "./fixtures.ts"

// ---------------------------------------------------------------------------
// Mocks shaped exactly like the @opencode/client 2.0.30 generated outputs the
// plugin context proxies to. The typed assignments below are compile-time
// shape pins: if the SDK's response wrappers change, this file stops
// typechecking (model.list/mcp.list return { location, data } wrappers;
// session.context returns the bare message array).
// ---------------------------------------------------------------------------

const serversOutput: McpListOutput = {
  location: { directory: "/work/project" },
  data: [{ name: "github", status: { status: "connected" } }, { name: "docs", status: { status: "pending" } }],
}

const modelsOutput: ModelListOutput = {
  location: { directory: "/work/project" },
  data: fixtureModels() as ModelListOutput["data"],
}

const contextMessages: SessionMessageInfo[] = fixtureSessionMessages() as unknown as SessionMessageInfo[]

/** Pushable async iterable standing in for the public event stream. */
function eventChannel(signal?: AbortSignal) {
  const queued: unknown[] = []
  let wake: (() => void) | undefined
  let done = false
  const push = (event: unknown) => {
    queued.push(event)
    wake?.()
  }
  signal?.addEventListener("abort", () => {
    done = true
    wake?.()
  })
  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (queued.length > 0) return { value: queued.shift(), done: false }
          if (done) return { value: undefined, done: true }
          await new Promise<void>(resolve => {
            wake = resolve
          })
          if (queued.length > 0) return { value: queued.shift(), done: false }
          return { value: undefined, done: true }
        },
      }
    },
  }
  return { push, iterable }
}

interface RpcCallContext {
  signal: AbortSignal
  error: (type: string, message: string, data: unknown) => { type: string; message: string; data: unknown }
}

const callContext: RpcCallContext = {
  signal: new AbortController().signal,
  error: (type, message, data) => ({ type, message, data }),
}

async function makePlugin(options: Record<string, unknown> = {}) {
  const hookRegistrations: { name: string; callback: (event: unknown) => void }[] = []
  const emitted: { name: string; data: unknown }[] = []
  let handlers: Record<string, (input: unknown, context: RpcCallContext) => Promise<unknown>> = {}
  const channel = eventChannel()
  const disposed: string[] = []
  // Hermetic persistence: each plugin instance gets its own state directory
  // (real worker + real sqlite), removed on cleanup.
  const storageDirectory = mkdtempSync(path.join(tmpdir(), "context-doctor-test-"))

  const ctx = {
    app: { version: "2.0.30-test", channel: "test" },
    location: { directory: "/work/project", project: { id: "p1", directory: "/work/project", canonical: "/work/project" } },
    options: { mcpRefreshMs: 0, maxSessions: 5, maxSnapshotsPerSession: 4, storageDirectory, ...options },
    mcp: { list: async () => serversOutput },
    model: { list: async () => modelsOutput },
    session: {
      context: async () => contextMessages,
      hook: async (name: string, callback: (event: unknown) => void) => {
        hookRegistrations.push({ name, callback })
        return { dispose: async () => disposed.push(`hook:${name}`) }
      },
    },
    rpc: {
      register: async (definition: unknown, impl: Record<string, (input: unknown, context: RpcCallContext) => Promise<unknown>>) => {
        assert.equal((definition as { id: string }).id, "context-doctor")
        handlers = impl
        return {
          dispose: async () => disposed.push("rpc"),
          events: { emit: async (name: string, data: unknown) => void emitted.push({ name, data }) },
        }
      },
    },
    event: { subscribe: (_options?: { signal?: AbortSignal }) => channel.iterable },
  }
  const rawCleanup = (await plugin.setup(ctx as never)) as () => void | Promise<void>
  const cleanup = async () => {
    await rawCleanup()
    rmSync(storageDirectory, { recursive: true, force: true })
  }
  const contextHook = hookRegistrations.find(r => r.name === "context")
  return { cleanup, contextHook, emitted, handlers, channel, disposed, hookRegistrations, storageDirectory }
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 10))

test("setup registers the context hook and all rpc methods", async () => {
  const p = await makePlugin()
  assert.ok(p.contextHook, "context hook not registered")
  assert.ok(p.handlers.list && p.handlers.report && p.handlers.diagnostics)
  await p.cleanup()
})

test("the context hook is observational: the event is never mutated", async () => {
  const p = await makePlugin()
  const event = JSON.parse(JSON.stringify(fixtureEvent())) as unknown
  const before = JSON.stringify(event)
  p.contextHook!.callback(event)
  assert.equal(JSON.stringify(event), before)
  await p.cleanup()
})

test("report fails with a typed error for unknown or invalid sessions", async () => {
  const p = await makePlugin()
  const unknown = (await p.handlers.report({ sessionID: "ses_missing" }, callContext)) as { type: string }
  assert.equal(unknown.type, "unknown_session")
  const invalid = (await p.handlers.report({}, callContext)) as { type: string }
  assert.equal(invalid.type, "invalid_input")
  await p.cleanup()
})

test("end-to-end: hook -> stored snapshot -> emitted event -> full report", async () => {
  const p = await makePlugin()
  p.contextHook!.callback(fixtureEvent())
  assert.equal(p.emitted.length, 1)
  assert.equal((p.emitted[0]!.data as { sessionID: string }).sessionID, "ses_test")

  const report = (await p.handlers.report({ sessionID: "ses_test" }, callContext)) as ReportPayload
  assert.equal(report.sessionID, "ses_test")
  assert.ok(report.totals.estimatedInputTokens > 0)
  assert.equal(report.system.parts, 2)
  assert.equal(report.messages.total, 4)
  assert.equal(report.tools.total, 3)
  // MCP grouping end-to-end through the mcp.list cache.
  const githubTool = report.tools.ranked.find(tool => tool.id === "github_create_issue")
  assert.equal(githubTool?.group.kind, "mcp-server")
  assert.equal(githubTool?.group.name, "github")
  // Reported usage from session.context (durable path) + registry window.
  assert.equal(report.reported.cumulative?.source, "session.context-sum")
  assert.equal(report.reported.durableSteps, 2)
  assert.equal(report.reported.contextWindowTokens, 200_000)
  assert.equal("utilizationReportedPct" in report.reported, false)
  assert.ok(report.reported.utilizationEstimatedPct !== undefined)
  assert.equal(report.retention.snapshotsForSession, 1)

  // An identical re-observation does not emit again.
  const event = fixtureEvent()
  p.contextHook!.callback(event)
  p.contextHook!.callback(event)
  assert.equal(p.emitted.length, 1)
  await p.cleanup()
})

test("multi-location isolation: only same-location usage events are applied", async () => {
  const p = await makePlugin()
  p.contextHook!.callback(fixtureEvent())
  await settle()

  // Foreign location: must be ignored entirely.
  p.channel.push({ type: "session.usage.updated", created: 50, location: { directory: "/somewhere/else" }, data: { sessionID: "ses_test", tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } } })
  // Missing location: unverifiable, ignored (fail closed).
  p.channel.push({ type: "session.usage.updated", created: 51, data: { sessionID: "ses_test", tokens: { input: 2, output: 1, cache: { read: 0, write: 0 } } } })
  // Untracked session at our location: ignored (session ownership).
  p.channel.push({ type: "session.usage.updated", created: 52, location: { directory: "/work/project" }, data: { sessionID: "ses_other", tokens: { input: 3, output: 1, cache: { read: 0, write: 0 } } } })
  await settle()
  let report = (await p.handlers.report({ sessionID: "ses_test" }, callContext)) as ReportPayload
  assert.equal(report.reported.cumulative?.source, "session.context-sum")

  // Same location + tracked session: cumulative total replaced (never summed).
  p.channel.push({ type: "session.usage.updated", created: 60, location: { directory: "/work/project" }, data: { sessionID: "ses_test", tokens: { input: 400_000, output: 9, reasoning: 0, cache: { read: 1_000, write: 0 } } } })
  // Older event arriving late must not overwrite.
  p.channel.push({ type: "session.usage.updated", created: 59, location: { directory: "/work/project" }, data: { sessionID: "ses_test", tokens: { input: 111, output: 9, reasoning: 0, cache: { read: 0, write: 0 } } } })
  // Auxiliary (title) usage: recorded but never in the totals.
  p.channel.push({ type: "session.usage.recorded", created: 61, location: { directory: "/work/project" }, data: { sessionID: "ses_test", source: "title", tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } })
  await settle()

  report = (await p.handlers.report({ sessionID: "ses_test" }, callContext)) as ReportPayload
  assert.equal(report.reported.cumulative?.source, "session.usage.updated")
  assert.equal(report.reported.cumulative?.tokens.input, 400_000)
  assert.equal(report.reported.cumulative?.ephemeral, true)
  assert.equal(report.reported.auxiliary?.length, 1)
  assert.equal(report.reported.auxiliary?.[0]?.source, "title")
  // No reported utilization exists at all; the raw tokens are displayed separately.
  assert.equal("utilizationReportedPct" in report.reported, false)
  await p.cleanup()
})

test("hook failures store a fixed code only - nothing reaches logs, storage, or RPC", async () => {
  const p = await makePlugin()
  // A successful snapshot first, so the session entry exists for error annotation.
  p.contextHook!.callback(fixtureEvent())

  // Capture every console argument: if the hook ever logs the raw error,
  // host log capture would persist the secret.
  const consoleCalls: unknown[][] = []
  const originalError = console.error
  const originalWarn = console.warn
  const originalLog = console.log
  console.error = (...args: unknown[]) => consoleCalls.push(args)
  console.warn = (...args: unknown[]) => consoleCalls.push(args)
  console.log = (...args: unknown[]) => consoleCalls.push(args)
  try {
    const event = fixtureEvent() as unknown as Record<string, unknown>
    Object.defineProperty(event, "system", {
      get() {
        throw new Error(`serialization failed while reading ${RAW_SECRET}`)
      },
    })
    p.contextHook!.callback(event)
  } finally {
    console.error = originalError
    console.warn = originalWarn
    console.log = originalLog
  }

  assert.equal(consoleCalls.length, 0)
  const report = (await p.handlers.report({ sessionID: "ses_test" }, callContext)) as ReportPayload
  assert.equal(report.errors.hookErrorCount, 1)
  assert.equal(report.errors.lastErrorCode, "analysis-failed")
  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes(RAW_SECRET))
  await p.cleanup()
})

test("FIRST-capture failures are visible: no silent drop when no snapshot exists yet", async () => {
  const p = await makePlugin()
  const consoleCalls: unknown[][] = []
  const originalError = console.error
  const originalWarn = console.warn
  const originalLog = console.log
  console.error = (...args: unknown[]) => consoleCalls.push(args)
  console.warn = (...args: unknown[]) => consoleCalls.push(args)
  console.log = (...args: unknown[]) => consoleCalls.push(args)
  try {
    // The session's very first hook observation throws before any snapshot
    // is stored. Previously recordError dropped this (no entry) and the
    // session became invisible: no list entry, no error anywhere.
    const event = fixtureEvent() as unknown as Record<string, unknown>
    Object.defineProperty(event, "messages", {
      get() {
        throw new Error(`first capture exploded near ${RAW_SECRET}`)
      },
    })
    p.contextHook!.callback(event)
  } finally {
    console.error = originalError
    console.warn = originalWarn
    console.log = originalLog
  }
  assert.equal(consoleCalls.length, 0, "hook must not log raw errors")

  // list stays empty (no snapshot) but diagnostics exposes the failure.
  const listed = (await p.handlers.list({}, callContext)) as { sessions: unknown[] }
  assert.equal(listed.sessions.length, 0)
  const diagnostics = (await p.handlers.diagnostics!({}, callContext)) as {
    instanceDirectory: string
    hookInvocations: number
    capturesStored: number
    captureFailures: number
    lastFailureCode: string
    sessionsWithSnapshots: number
    sessionsWithErrorOnly: number
  }
  assert.equal(diagnostics.instanceDirectory, "/work/project")
  assert.equal(diagnostics.hookInvocations, 1)
  assert.equal(diagnostics.capturesStored, 0)
  assert.equal(diagnostics.captureFailures, 1)
  assert.equal(diagnostics.lastFailureCode, "analysis-failed")
  assert.equal(diagnostics.sessionsWithSnapshots, 0)
  assert.equal(diagnostics.sessionsWithErrorOnly, 1)

  // The report for the failed session says WHY, with bounded metadata only.
  const failed = (await p.handlers.report({ sessionID: "ses_test" }, callContext)) as {
    type: string
    message: string
    data: { reason: string; instanceDirectory: string; hookErrorCount: number; lastErrorCode: string }
  }
  assert.equal(failed.type, "unknown_session")
  assert.equal(failed.data.reason, "hook_error")
  assert.equal(failed.data.instanceDirectory, "/work/project")
  assert.equal(failed.data.hookErrorCount, 1)
  assert.equal(failed.data.lastErrorCode, "analysis-failed")
  assert.ok(!JSON.stringify(failed).includes(RAW_SECRET))

  // A later good capture adopts the same session entry and keeps the error history.
  p.contextHook!.callback(fixtureEvent())
  const report = (await p.handlers.report({ sessionID: "ses_test" }, callContext)) as ReportPayload
  assert.ok(report.totals.estimatedInputTokens > 0)
  assert.equal(report.errors.hookErrorCount, 1)
  const recovered = (await p.handlers.diagnostics!({}, callContext)) as { capturesStored: number; captureFailures: number }
  assert.equal(recovered.capturesStored, 1)
  assert.equal(recovered.captureFailures, 1)
  await p.cleanup()
})

test("report for a never-observed session explains location scoping (no_capture)", async () => {
  const p = await makePlugin()
  const unknown = (await p.handlers.report({ sessionID: "ses_elsewhere" }, callContext)) as {
    type: string
    message: string
    data: { sessionID: string; reason: string; instanceDirectory: string }
  }
  assert.equal(unknown.type, "unknown_session")
  assert.equal(unknown.data.reason, "no_capture")
  assert.equal(unknown.data.instanceDirectory, "/work/project")
  assert.ok(unknown.message.includes("/work/project"), "message names the instance location")
  assert.equal("hookErrorCount" in unknown.data, false)
  await p.cleanup()
})

test("diagnostics reflects a healthy instance before and after captures", async () => {
  const p = await makePlugin()
  const fresh = (await p.handlers.diagnostics!({}, callContext)) as {
    hookInvocations: number
    capturesStored: number
    captureFailures: number
    maxSessions: number
    maxSnapshotsPerSession: number
  }
  assert.deepEqual(
    [fresh.hookInvocations, fresh.capturesStored, fresh.captureFailures, fresh.maxSessions, fresh.maxSnapshotsPerSession],
    [0, 0, 0, 5, 4],
  )
  p.contextHook!.callback(fixtureEvent())
  p.contextHook!.callback(fixtureEvent()) // unchanged re-observation: no new store
  const after = (await p.handlers.diagnostics!({}, callContext)) as {
    hookInvocations: number
    capturesStored: number
    captureFailures: number
    sessionsWithSnapshots: number
  }
  assert.deepEqual([after.hookInvocations, after.capturesStored, after.captureFailures, after.sessionsWithSnapshots], [2, 1, 0, 1])
  await p.cleanup()
})

test("list returns tracked-session summaries", async () => {
  const p = await makePlugin()
  p.contextHook!.callback(fixtureEvent())
  const output = (await p.handlers.list({}, callContext)) as { sessions: { sessionID: string; lastEstimatedInputTokens: number }[] }
  assert.equal(output.sessions.length, 1)
  assert.equal(output.sessions[0]!.sessionID, "ses_test")
  assert.ok(output.sessions[0]!.lastEstimatedInputTokens > 0)
  await p.cleanup()
})

test("cleanup disposes registrations and aborts the event stream", async () => {
  const p = await makePlugin()
  await p.cleanup()
  assert.ok(p.disposed.includes("hook:context"))
  assert.ok(p.disposed.includes("rpc"))
})

test("options are clamped to sane ranges", () => {
  const resolved = parseOptions({ maxSessions: 9_999, maxSnapshotsPerSession: 0, mcpRefreshMs: -5, maxRankedTools: 1_000 })
  assert.equal(resolved.maxSessions, 500)
  assert.equal(resolved.maxSnapshotsPerSession, 1)
  assert.equal(resolved.mcpRefreshMs, 0)
  assert.equal(resolved.maxRankedTools, 50)
  assert.deepEqual(parseOptions(null).maxSessions === 50 && parseOptions("junk").maxRankedTools === 12, true)
})

test("the plugin id matches the rpc id", () => {
  // Plugin.define returns the definition; the exported default carries id + setup.
  assert.equal((plugin as { id: string }).id, ContextDoctor.id)
})
