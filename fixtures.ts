/**
 * Shared test fixtures: builders that construct structurally valid hook
 * events, session messages, model entries, and a full report payload.
 * Used by the *.test.ts files (and typechecked with the same strict config).
 */
import type { ContextEventLike, Analysis } from "./analytics.ts"
import { analyzeContextEvent } from "./analytics.ts"
import { buildReported } from "./enrich.ts"
import { buildReportPayload } from "./report.ts"
import type { GlobalStatsPayload, ReportPayload } from "./types.ts"
import { GLOBAL_STATS_NOTES } from "./types.ts"
import { USAGE_NOTES } from "./usage.ts"
export const RAW_SECRET = "SECRET-RAW-CONTENT-do-not-store"

export function fixtureEvent(overrides: Partial<ContextEventLike> = {}): ContextEventLike {
  return {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "high" },
    system: [
      {
        type: "text",
        text: "You are a coding agent. Follow AGENTS.md instructions.",
        metadata: { source: "file:///workspace/AGENTS.md" },
      },
      { type: "text", text: "Tool catalog preamble follows.", cache: { hint: "ephemeral" } as never },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Please read the config. ${RAW_SECRET}` },
          {
            type: "media",
            media: { source: { type: "url", url: "https://example.com/diagram.png", mediaType: "image/png" } },
          } as never,
        ],
      } as never,
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Thinking about the request." },
          { type: "text", text: "I will read the config file." },
          { type: "tool-call", id: "call_1", name: "read", input: { path: "/etc/app.conf" } },
        ],
      } as never,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call_1",
            name: "read",
            result: { type: "text", value: `[file contents] ${RAW_SECRET}` },
          },
        ],
      } as never,
      {
        role: "assistant",
        content: [{ type: "text", text: "The config sets server.port=8080." }],
      } as never,
    ],
    tools: {
      read: { description: "Read a file from the local filesystem.", input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      bash: { description: "Execute a command in the shell.", input: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] } },
      github_create_issue: {
        description: "Create an issue in a GitHub repository.",
        input: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] },
      },
    },
    ...overrides,
  }
}

export function fixtureAnalysis(overrides: { event?: ContextEventLike; now?: () => number; mcpServers?: readonly string[] } = {}): Analysis {
  return analyzeContextEvent(overrides.event ?? fixtureEvent(), {
    now: overrides.now ?? (() => 1_700_000_000_000),
    mcpServers: overrides.mcpServers ?? ["github"],
  })
}

export function fixtureSessionMessages(): unknown[] {
  return [
    { type: "user", id: "msg_1", time: { created: 1_699_999_000_000 }, content: [] },
    {
      type: "assistant",
      id: "msg_2",
      time: { created: 1_700_000_100_000 },
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      tokens: { input: 90_000, output: 1_200, reasoning: 300, cache: { read: 80_000, write: 4_000 } },
      content: [],
    },
    {
      type: "assistant",
      id: "msg_3",
      time: { created: 1_700_000_200_000 },
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      tokens: { input: 100_000, output: 900, reasoning: 100, cache: { read: 85_000, write: 3_000 } },
      content: [],
    },
    { type: "assistant", id: "msg_4", time: { created: 1_700_000_300_000 }, model: { providerID: "anthropic", id: "claude-sonnet-4-5" }, content: [] },
    { type: "system", id: "msg_5", time: { created: 1_700_000_400_000 }, content: [] },
  ]
}

export function fixtureModels(): unknown[] {
  return [
    { id: "claude-sonnet-4-5", modelID: "claude-sonnet-4-5", providerID: "anthropic", limit: { context: 200_000, output: 16_384 } },
    { id: "gpt-5", modelID: "gpt-5", providerID: "openai", limit: { context: 400_000, output: 128_000 } },
  ]
}

export function fixtureReport(options: { analysis?: Analysis; snapshots?: readonly Analysis[] } = {}): ReportPayload {
  const analysis = options.analysis ?? fixtureAnalysis()
  const snapshots = options.snapshots ?? [analysis]
  const reported = buildReported({
    estimatedInputTokens: analysis.totals.estimatedInputTokens,
    usage: {
      auxiliary: [{ source: "title", capturedAt: 1_700_000_050_000, tokens: { input: 500, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
    },
    durable: {
      steps: 2,
      total: { input: 190_000, output: 2_100, reasoning: 400, cacheRead: 165_000, cacheWrite: 7_000 },
      last: {
        tokens: { input: 100_000, output: 900, reasoning: 100, cacheRead: 85_000, cacheWrite: 3_000 },
        createdAt: 1_700_000_200_000,
        model: "anthropic/claude-sonnet-4-5",
      },
    },
    contextWindowTokens: 200_000,
    usageNotes: USAGE_NOTES,
  })
  return buildReportPayload({
    analysis,
    snapshots,
    retention: { maxSessions: 50, maxSnapshotsPerSession: 20, sessionsTracked: 3, snapshotsForSession: snapshots.length },
    errors: { hookErrorCount: 0 },
    reported,
  })
}

export function fixtureStats(overrides: Partial<GlobalStatsPayload> = {}): GlobalStatsPayload {
  return {
    version: 1,
    available: true,
    generatedAt: 1_700_000_300_000,
    coverage: "captured-sessions",
    totals: { locations: 2, sessions: 3, snapshots: 7, payloadBytes: 8_192, rawBytes: 40_960, firstCapturedAt: 1_700_000_000_000, lastCapturedAt: 1_700_000_200_000 },
    context: {
      sessionsWithSnapshots: 3,
      avgLatestEstimatedInputTokens: 120_000,
      peakEstimatedInputTokens: 200_000,
      perModel: [
        { providerID: "anthropic", id: "claude-sonnet-4-5", sessions: 2, snapshots: 5, avgLatestEstimatedInputTokens: 130_000, peakEstimatedInputTokens: 200_000, sumLatestEstimatedInputTokens: 260_000 },
        { providerID: "openai", id: "gpt-5", sessions: 1, snapshots: 2, avgLatestEstimatedInputTokens: 100_000, peakEstimatedInputTokens: 100_000, sumLatestEstimatedInputTokens: 100_000 },
      ],
    },
    usage: {
      sessionsWithUsage: 2,
      capturedThrough: 1_700_000_250_000,
      tokens: { input: 290_000, output: 3_000, reasoning: 400, cacheRead: 250_000, cacheWrite: 7_000 },
    },
    tools: {
      schema: [{ id: "read", sessions: 3, estimatedTokens: 900 }, { id: "github_create_issue", sessions: 1, estimatedTokens: 1_200 }],
      io: [{ name: "read", sessions: 3, calls: 6, results: 6, estimatedTokens: 24_000 }],
    },
    sessions: [
      { sessionID: "ses_test", directory: "/work/project", agent: "build", model: { providerID: "anthropic", id: "claude-sonnet-4-5" }, lastCapturedAt: 1_700_000_200_000, lastActiveAt: 1_700_000_210_000, snapshotCount: 3, latestEstimatedInputTokens: 123_456, peakEstimatedInputTokens: 200_000 },
      { sessionID: "ses_other", directory: "/work/other", agent: "build", model: { providerID: "openai", id: "gpt-5" }, lastCapturedAt: 1_700_000_150_000, lastActiveAt: 1_700_000_160_000, snapshotCount: 2, latestEstimatedInputTokens: 100_000, peakEstimatedInputTokens: 100_000 },
    ],
    locations: [
      { directory: "/work/project", sessions: 2, snapshots: 5, lastActiveAt: 1_700_000_210_000 },
      { directory: "/work/other", sessions: 1, snapshots: 2, lastActiveAt: 1_700_000_160_000 },
    ],
    retention: { byteBudgetBytes: 33_554_432, maxAgeMs: 2_592_000_000, maxSessionsPerLocation: 50, sessions: 3, snapshots: 7 },
    notes: GLOBAL_STATS_NOTES,
    ...overrides,
  }
}
