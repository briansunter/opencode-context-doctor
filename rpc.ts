/**
 * Typed RPC contract between the server plugin and the TUI.
 *
 * JSON Schema is used (dependency-free), matching the OpenCode V2
 * `Rpc.define` portable-definition format. JSON Schema values are `unknown`
 * to TypeScript, so callers narrow; the shapes here are kept in lockstep with
 * the interfaces in types.ts (enforced by tests).
 *
 * The TUI calls these methods through `context.client.rpc(ContextDoctor)` with
 * an explicit `location` (see tui.tsx): the server plugin instance is bound to
 * its own `ctx.location`, and RPC routing is location-scoped.
 */
import { Rpc } from "@opencode/plugin/rpc"
import { HOOK_ERROR_CODES, PERSIST_ERROR_CODES } from "./error-codes.ts"

const stringSchema = { type: "string" } as const
const nonEmptyString = { type: "string", minLength: 1 } as const
const numberSchema = { type: "number" } as const
const integerSchema = { type: "integer", minimum: 0 } as const

const modelRefSchema = {
  type: "object",
  properties: {
    providerID: nonEmptyString,
    id: nonEmptyString,
    variant: stringSchema,
  },
  required: ["providerID", "id"],
  additionalProperties: false,
} as const

const toolGroupSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["mcp-server", "other"] },
    name: stringSchema,
    attribution: { type: "string", enum: ["heuristic-prefix", "none"] },
  },
  required: ["kind", "name", "attribution"],
  additionalProperties: false,
} as const

const toolCostSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    estimatedTokens: integerSchema,
    descriptionCharacters: integerSchema,
    schemaCharacters: integerSchema,
    schemaProperties: integerSchema,
    group: toolGroupSchema,
  },
  required: ["id", "estimatedTokens", "descriptionCharacters", "schemaCharacters", "schemaProperties", "group"],
  additionalProperties: false,
} as const

const toolGroupTotalSchema = {
  type: "object",
  properties: {
    name: stringSchema,
    kind: { type: "string", enum: ["mcp-server", "other"] },
    tools: integerSchema,
    estimatedTokens: integerSchema,
    share: numberSchema,
    attribution: { type: "string", enum: ["heuristic-prefix", "none"] },
  },
  required: ["name", "kind", "tools", "estimatedTokens", "share", "attribution"],
  additionalProperties: false,
} as const

const systemProvenanceSchema = {
  type: "object",
  properties: {
    available: { type: "boolean", enum: [false] },
    sources: { type: "array", items: {} },
    note: stringSchema,
  },
  required: ["available", "sources", "note"],
  additionalProperties: false,
} as const

const systemSchema = {
  type: "object",
  properties: {
    parts: integerSchema,
    characters: integerSchema,
    estimatedTokens: integerSchema,
    cacheHintedParts: integerSchema,
    provenance: systemProvenanceSchema,
  },
  required: ["parts", "characters", "estimatedTokens", "cacheHintedParts", "provenance"],
  additionalProperties: false,
} as const

const roleBreakdownSchema = {
  type: "object",
  properties: {
    role: stringSchema,
    messages: integerSchema,
    parts: integerSchema,
    estimatedTokens: integerSchema,
    characters: integerSchema,
  },
  required: ["role", "messages", "parts", "estimatedTokens", "characters"],
  additionalProperties: false,
} as const

const partTypeBreakdownSchema = {
  type: "object",
  properties: {
    partType: stringSchema,
    parts: integerSchema,
    estimatedTokens: integerSchema,
    characters: integerSchema,
    countedOnly: { type: "boolean" },
    note: stringSchema,
  },
  required: ["partType", "parts", "estimatedTokens", "characters", "countedOnly"],
  additionalProperties: false,
} as const

const messageSizeSchema = {
  type: "object",
  properties: {
    index: integerSchema,
    role: stringSchema,
    parts: integerSchema,
    estimatedTokens: integerSchema,
    characters: integerSchema,
  },
  required: ["index", "role", "parts", "estimatedTokens", "characters"],
  additionalProperties: false,
} as const

const categoryBreakdownSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["user-text", "assistant-text", "other-text", "reasoning", "tool-io", "media", "other"] },
    parts: integerSchema,
    estimatedTokens: integerSchema,
  },
  required: ["category", "parts", "estimatedTokens"],
  additionalProperties: false,
} as const

const messagesSchema = {
  type: "object",
  properties: {
    total: integerSchema,
    byRole: { type: "array", items: roleBreakdownSchema },
    byPartType: { type: "array", items: partTypeBreakdownSchema },
    categories: { type: "array", items: categoryBreakdownSchema },
    largest: { type: "array", items: messageSizeSchema },
  },
  required: ["total", "byRole", "byPartType", "categories", "largest"],
  additionalProperties: false,
} as const

const toolIOCostSchema = {
  type: "object",
  properties: {
    name: stringSchema,
    calls: integerSchema,
    results: integerSchema,
    estimatedCallTokens: integerSchema,
    estimatedResultTokens: integerSchema,
    estimatedTokens: integerSchema,
  },
  required: ["name", "calls", "results", "estimatedCallTokens", "estimatedResultTokens", "estimatedTokens"],
  additionalProperties: false,
} as const

const toolIOSchema = {
  type: "object",
  properties: {
    totalCalls: integerSchema,
    totalResults: integerSchema,
    estimatedTokens: integerSchema,
    ranked: { type: "array", items: toolIOCostSchema },
    note: stringSchema,
  },
  required: ["totalCalls", "totalResults", "estimatedTokens", "ranked", "note"],
  additionalProperties: false,
} as const

const toolsSchema = {
  type: "object",
  properties: {
    total: integerSchema,
    estimatedTokens: integerSchema,
    ranked: { type: "array", items: toolCostSchema },
    groups: { type: "array", items: toolGroupTotalSchema },
    source: { type: "string", enum: ["context-hook-request-snapshot"] },
    attributionNote: stringSchema,
    io: toolIOSchema,
  },
  required: ["total", "estimatedTokens", "ranked", "groups", "source", "attributionNote", "io"],
  additionalProperties: false,
} as const

const scopeSchema = {
  type: "object",
  properties: {
    hook: { type: "string", enum: ["context"] },
    kinds: { type: "array", items: { type: "string", enum: ["primary"] } },
    note: stringSchema,
  },
  required: ["hook", "kinds", "note"],
  additionalProperties: false,
} as const

const estimationSchema = {
  type: "object",
  properties: {
    method: { type: "string", enum: ["heuristic-local"] },
    latinCharsPerToken: numberSchema,
    cjkCharsPerToken: numberSchema,
    remoteCalls: { type: "boolean", enum: [false] },
    note: stringSchema,
  },
  required: ["method", "latinCharsPerToken", "cjkCharsPerToken", "remoteCalls", "note"],
  additionalProperties: false,
} as const

const reportedTokensSchema = {
  type: "object",
  properties: {
    input: numberSchema,
    output: numberSchema,
    reasoning: numberSchema,
    cacheRead: numberSchema,
    cacheWrite: numberSchema,
  },
  required: ["input", "output", "reasoning", "cacheRead", "cacheWrite"],
  additionalProperties: false,
} as const

const cumulativeSchema = {
  type: "object",
  properties: {
    tokens: reportedTokensSchema,
    capturedAt: numberSchema,
    source: { type: "string", enum: ["session.usage.updated", "session.context-sum"] },
    ephemeral: { type: "boolean" },
  },
  required: ["tokens", "capturedAt", "source", "ephemeral"],
  additionalProperties: false,
} as const

const lastStepSchema = {
  type: "object",
  properties: {
    tokens: reportedTokensSchema,
    createdAt: numberSchema,
    model: stringSchema,
  },
  required: ["tokens", "createdAt", "model"],
  additionalProperties: false,
} as const

const auxiliarySchema = {
  type: "object",
  properties: {
    source: stringSchema,
    capturedAt: numberSchema,
    tokens: reportedTokensSchema,
  },
  required: ["source", "capturedAt", "tokens"],
  additionalProperties: false,
} as const

const reportedSchema = {
  type: "object",
  properties: {
    available: { type: "boolean" },
    cumulative: cumulativeSchema,
    durableSteps: integerSchema,
    lastStep: lastStepSchema,
    auxiliary: { type: "array", items: auxiliarySchema },
    contextWindowTokens: integerSchema,
    contextWindowSource: { type: "string", enum: ["model.limit.context", "none"] },
    utilizationEstimatedPct: numberSchema,
    notes: { type: "array", items: stringSchema },
  },
  required: ["available", "contextWindowSource", "notes"],
  additionalProperties: false,
} as const

const historyPointSchema = {
  type: "object",
  properties: {
    capturedAt: numberSchema,
    estimatedInputTokens: integerSchema,
    messageCount: integerSchema,
    systemTokens: integerSchema,
    messageTokens: integerSchema,
    toolTokens: integerSchema,
  },
  required: ["capturedAt", "estimatedInputTokens", "messageCount", "systemTokens", "messageTokens", "toolTokens"],
  additionalProperties: false,
} as const

const retentionSchema = {
  type: "object",
  properties: {
    maxSessions: integerSchema,
    maxSnapshotsPerSession: integerSchema,
    sessionsTracked: integerSchema,
    snapshotsForSession: integerSchema,
  },
  required: ["maxSessions", "maxSnapshotsPerSession", "sessionsTracked", "snapshotsForSession"],
  additionalProperties: false,
} as const

const errorInfoSchema = {
  type: "object",
  properties: {
    hookErrorCount: integerSchema,
    lastErrorAt: numberSchema,
    lastErrorCode: { type: "string", enum: [...HOOK_ERROR_CODES] },
  },
  required: ["hookErrorCount"],
  additionalProperties: false,
} as const

const totalsSchema = {
  type: "object",
  properties: {
    estimatedInputTokens: integerSchema,
    systemTokens: integerSchema,
    messageTokens: integerSchema,
    toolTokens: integerSchema,
    systemShare: numberSchema,
    messageShare: numberSchema,
    toolShare: numberSchema,
  },
  required: [
    "estimatedInputTokens",
    "systemTokens",
    "messageTokens",
    "toolTokens",
    "systemShare",
    "messageShare",
    "toolShare",
  ],
  additionalProperties: false,
} as const

const reportOutputSchema = {
  type: "object",
  properties: {
    version: { type: "integer", enum: [1] },
    sessionID: nonEmptyString,
    agent: stringSchema,
    model: modelRefSchema,
    capturedAt: numberSchema,
    scope: scopeSchema,
    estimation: estimationSchema,
    system: systemSchema,
    messages: messagesSchema,
    tools: toolsSchema,
    totals: totalsSchema,
    history: { type: "array", items: historyPointSchema },
    reported: reportedSchema,
    retention: retentionSchema,
    errors: errorInfoSchema,
    limits: { type: "array", items: stringSchema },
  },
  required: [
    "version",
    "sessionID",
    "agent",
    "model",
    "capturedAt",
    "scope",
    "estimation",
    "system",
    "messages",
    "tools",
    "totals",
    "history",
    "reported",
    "retention",
    "errors",
    "limits",
  ],
  additionalProperties: false,
} as const

const sessionSummarySchema = {
  type: "object",
  properties: {
    sessionID: nonEmptyString,
    agent: stringSchema,
    model: modelRefSchema,
    snapshotCount: { type: "integer", minimum: 1 },
    lastCapturedAt: numberSchema,
    lastEstimatedInputTokens: integerSchema,
    lastMessageCount: integerSchema,
    hookErrorCount: integerSchema,
    lastActiveAt: numberSchema,
  },
  required: [
    "sessionID",
    "agent",
    "model",
    "snapshotCount",
    "lastCapturedAt",
    "lastEstimatedInputTokens",
    "lastMessageCount",
    "hookErrorCount",
    "lastActiveAt",
  ],
  additionalProperties: false,
} as const

const persistenceHealthSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["pending", "active", "degraded", "disabled"] },
    mode: { type: "string", enum: ["sqlite-worker", "none"] },
    directory: stringSchema,
    dbPath: stringSchema,
    engine: stringSchema,
    /** Fixed code from PERSIST_ERROR_CODES; never a free-form message. */
    lastErrorCode: { type: "string", enum: [...PERSIST_ERROR_CODES] },
    lastErrorAt: numberSchema,
    flushes: integerSchema,
    flushFailures: integerSchema,
    flushedSessions: integerSchema,
    lastFlushAt: numberSchema,
    dirtySessions: integerSchema,
    hydratedSessions: integerSchema,
    hydratedAt: numberSchema,
    retention: {
      type: "object",
      properties: {
        maxAgeMs: { type: "integer", minimum: 1000 },
        byteBudgetBytes: { type: "integer", minimum: 0 },
        maxSessionsPerLocation: { type: "integer", minimum: 1 },
      },
      required: ["maxAgeMs", "byteBudgetBytes", "maxSessionsPerLocation"],
      additionalProperties: false,
    },
    totals: {
      type: "object",
      properties: {
        locations: integerSchema,
        sessions: integerSchema,
        snapshots: integerSchema,
        fileBytes: integerSchema,
        payloadBytes: integerSchema,
        rawBytes: integerSchema,
        compressionRatio: { type: "number", minimum: 0 },
      },
      required: ["locations", "sessions", "snapshots", "fileBytes", "payloadBytes"],
      additionalProperties: false,
    },
  },
  required: ["status", "mode", "flushes", "flushFailures", "flushedSessions", "dirtySessions", "hydratedSessions", "retention"],
  additionalProperties: false,
} as const

const globalModelBreakdownSchema = {
  type: "object",
  properties: {
    providerID: nonEmptyString,
    id: nonEmptyString,
    sessions: integerSchema,
    snapshots: integerSchema,
    avgLatestEstimatedInputTokens: integerSchema,
    peakEstimatedInputTokens: integerSchema,
    sumLatestEstimatedInputTokens: integerSchema,
  },
  required: ["providerID", "id", "sessions", "snapshots", "avgLatestEstimatedInputTokens", "peakEstimatedInputTokens", "sumLatestEstimatedInputTokens"],
  additionalProperties: false,
} as const

const globalToolSchemaTotalSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    sessions: integerSchema,
    estimatedTokens: integerSchema,
  },
  required: ["id", "sessions", "estimatedTokens"],
  additionalProperties: false,
} as const

const globalToolIOTotalSchema = {
  type: "object",
  properties: {
    name: stringSchema,
    sessions: integerSchema,
    calls: integerSchema,
    results: integerSchema,
    estimatedTokens: integerSchema,
  },
  required: ["name", "sessions", "calls", "results", "estimatedTokens"],
  additionalProperties: false,
} as const

const globalSessionSampleSchema = {
  type: "object",
  properties: {
    sessionID: nonEmptyString,
    directory: stringSchema,
    agent: stringSchema,
    model: modelRefSchema,
    lastCapturedAt: numberSchema,
    lastActiveAt: numberSchema,
    snapshotCount: integerSchema,
    latestEstimatedInputTokens: integerSchema,
    peakEstimatedInputTokens: integerSchema,
  },
  required: ["sessionID", "directory", "agent", "model", "lastCapturedAt", "lastActiveAt", "snapshotCount", "latestEstimatedInputTokens", "peakEstimatedInputTokens"],
  additionalProperties: false,
} as const

const globalLocationSummarySchema = {
  type: "object",
  properties: {
    directory: stringSchema,
    workspaceID: stringSchema,
    sessions: integerSchema,
    snapshots: integerSchema,
    lastActiveAt: numberSchema,
  },
  required: ["directory", "sessions", "snapshots", "lastActiveAt"],
  additionalProperties: false,
} as const

const globalStatsOutputSchema = {
  type: "object",
  properties: {
    version: { type: "integer", enum: [1] },
    available: { type: "boolean" },
    /** Fixed reason code from the closed PERSIST_ERROR_CODES vocabulary. */
    reason: { type: "string", enum: [...PERSIST_ERROR_CODES] },
    generatedAt: numberSchema,
    coverage: { type: "string", enum: ["captured-sessions"] },
    totals: {
      type: "object",
      properties: {
        locations: integerSchema,
        sessions: integerSchema,
        snapshots: integerSchema,
        payloadBytes: integerSchema,
        rawBytes: integerSchema,
        firstCapturedAt: numberSchema,
        lastCapturedAt: numberSchema,
      },
      required: ["locations", "sessions", "snapshots", "payloadBytes", "rawBytes"],
      additionalProperties: false,
    },
    context: {
      type: "object",
      properties: {
        sessionsWithSnapshots: integerSchema,
        avgLatestEstimatedInputTokens: integerSchema,
        peakEstimatedInputTokens: integerSchema,
        perModel: { type: "array", items: globalModelBreakdownSchema },
      },
      required: ["sessionsWithSnapshots", "avgLatestEstimatedInputTokens", "peakEstimatedInputTokens", "perModel"],
      additionalProperties: false,
    },
    usage: {
      type: "object",
      properties: {
        sessionsWithUsage: integerSchema,
        capturedThrough: numberSchema,
        tokens: reportedTokensSchema,
      },
      required: ["sessionsWithUsage", "tokens"],
      additionalProperties: false,
    },
    tools: {
      type: "object",
      properties: {
        schema: { type: "array", items: globalToolSchemaTotalSchema },
        io: { type: "array", items: globalToolIOTotalSchema },
      },
      required: ["schema", "io"],
      additionalProperties: false,
    },
    sessions: { type: "array", items: globalSessionSampleSchema },
    locations: { type: "array", items: globalLocationSummarySchema },
    retention: {
      type: "object",
      properties: {
        byteBudgetBytes: integerSchema,
        maxAgeMs: { type: "integer", minimum: 1000 },
        maxSessionsPerLocation: { type: "integer", minimum: 1 },
        sessions: integerSchema,
        snapshots: integerSchema,
      },
      required: ["byteBudgetBytes", "maxAgeMs", "maxSessionsPerLocation", "sessions", "snapshots"],
      additionalProperties: false,
    },
    notes: { type: "array", items: stringSchema },
  },
  required: ["version", "available", "generatedAt", "coverage", "totals", "context", "sessions", "locations", "retention", "notes"],
  additionalProperties: false,
} as const

export const ContextDoctor = Rpc.define({
  id: "context-doctor",
  methods: {
    list: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { sessions: { type: "array", items: sessionSummarySchema } },
        required: ["sessions"],
        additionalProperties: false,
      },
    },
    report: {
      input: {
        type: "object",
        properties: { sessionID: nonEmptyString },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: reportOutputSchema,
      errors: {
        unknown_session: {
          type: "object",
          properties: {
            sessionID: nonEmptyString,
            /** no_capture: this instance never observed a context assembly for the session (e.g. the session lives in another location). hook_error: captures were attempted but failed. */
            reason: { type: "string", enum: ["no_capture", "hook_error"] },
            instanceDirectory: stringSchema,
            hookErrorCount: integerSchema,
            lastErrorCode: { type: "string", enum: [...HOOK_ERROR_CODES] },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        invalid_input: {
          type: "object",
          properties: { field: nonEmptyString },
          required: ["field"],
          additionalProperties: false,
        },
      },
    },
    diagnostics: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          /** Location this plugin instance is bound to; RPC calls are routed per location. */
          instanceDirectory: nonEmptyString,
          hookInvocations: integerSchema,
          capturesStored: integerSchema,
          captureFailures: integerSchema,
          lastFailureAt: numberSchema,
          lastFailureCode: { type: "string", enum: [...HOOK_ERROR_CODES] },
          sessionsWithSnapshots: integerSchema,
          sessionsWithErrorOnly: integerSchema,
          maxSessions: integerSchema,
          maxSnapshotsPerSession: integerSchema,
          persistence: persistenceHealthSchema,
        },
        required: [
          "instanceDirectory",
          "hookInvocations",
          "capturesStored",
          "captureFailures",
          "sessionsWithSnapshots",
          "sessionsWithErrorOnly",
          "maxSessions",
          "maxSnapshotsPerSession",
        ],
        additionalProperties: false,
      },
    },
    stats: {
      input: {
        type: "object",
        properties: { topN: { type: "integer", minimum: 1, maximum: 50 } },
        additionalProperties: false,
      },
      output: globalStatsOutputSchema,
    },
  },
  events: {
    captured: {
      schema: {
        type: "object",
        properties: {
          sessionID: nonEmptyString,
          capturedAt: numberSchema,
          estimatedInputTokens: integerSchema,
        },
        required: ["sessionID", "capturedAt", "estimatedInputTokens"],
        additionalProperties: false,
      },
    },
  },
})
