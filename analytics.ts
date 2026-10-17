/**
 * Pure analysis of an assembled model-request context.
 *
 * Input is the structural subset of the OpenCode V2 `session.hook("context")`
 * event that this plugin reads. The hook exposes the *direct* per-request
 * snapshot: `tools` is the exact Record of tool definitions the model call
 * will carry (`Record<string, { description, input: JsonSchema }>`). It is
 * NOT the same as `ctx.tool.list()` (the full registered catalog) and this
 * plugin never substitutes the catalog for the request snapshot.
 *
 * The analysis is strictly observational: it never mutates the event, stores
 * no raw content (only keys, sizes, counts, and estimates), and performs no
 * network access.
 */
import type { Message, SystemPart } from "@opencode/ai"
import { defaultRatios, estimateJsonTokens, estimateTextTokens, serializeJson, type EstimateRatios } from "./estimate.ts"

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/** Structural, read-only subset of the V2 `SessionContext` hook event. */
export interface ContextEventLike {
  readonly sessionID: string
  readonly agent: string
  readonly model: ModelRef
  readonly system: readonly SystemPart[]
  readonly messages: readonly Message[]
  readonly tools: Readonly<Record<string, { readonly description: string; readonly input: unknown }>>
}

export interface AnalyzeOptions {
  readonly now?: () => number
  readonly ratios?: EstimateRatios
  /** MCP server names used for the heuristic tool-id prefix grouping. */
  readonly mcpServers?: readonly string[]
  readonly maxRankedTools?: number
  readonly maxLargestMessages?: number
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ToolGroupAttribution = "heuristic-prefix" | "none"

export interface ToolGroup {
  readonly kind: "mcp-server" | "other"
  readonly name: string
  readonly attribution: ToolGroupAttribution
}

/** Per-tool schema cost. Stores the tool *key* and sizes only - never the description text or schema JSON. */
export interface ToolCost {
  readonly id: string
  readonly estimatedTokens: number
  readonly descriptionCharacters: number
  readonly schemaCharacters: number
  readonly schemaProperties: number
  readonly group: ToolGroup
}

export interface ToolGroupTotal {
  readonly name: string
  readonly kind: "mcp-server" | "other"
  readonly tools: number
  readonly estimatedTokens: number
  readonly share: number
  readonly attribution: ToolGroupAttribution
}

export interface SystemAnalysis {
  readonly parts: number
  readonly characters: number
  readonly estimatedTokens: number
  readonly cacheHintedParts: number
  readonly provenance: {
    readonly available: false
    readonly sources: readonly []
    readonly note: string
  }
}

export interface RoleBreakdown {
  readonly role: string
  readonly messages: number
  readonly parts: number
  readonly estimatedTokens: number
  readonly characters: number
}

export interface PartTypeBreakdown {
  readonly partType: string
  readonly parts: number
  readonly estimatedTokens: number
  readonly characters: number
  /** True when the part is counted but deliberately not token-estimated (media, encrypted payloads, ...). */
  readonly countedOnly: boolean
  readonly note?: string
}

export interface MessageSize {
  readonly index: number
  readonly role: string
  readonly parts: number
  readonly estimatedTokens: number
  readonly characters: number
}

export interface MessagesAnalysis {
  readonly total: number
  readonly byRole: readonly RoleBreakdown[]
  readonly byPartType: readonly PartTypeBreakdown[]
  /** Cross of role and part type: user text vs assistant text vs reasoning vs tool I/O. */
  readonly categories: readonly CategoryBreakdown[]
  readonly largest: readonly MessageSize[]
}

export type MessageCategory = "user-text" | "assistant-text" | "other-text" | "reasoning" | "tool-io" | "media" | "other"

export interface CategoryBreakdown {
  readonly category: MessageCategory
  readonly parts: number
  readonly estimatedTokens: number
}

/**
 * Per-tool transcript I/O: estimated cost of tool-call inputs and tool-result
 * outputs carried in the message history, keyed by the tool name recorded on
 * each transcript part. Separate from the per-request schema footprint.
 */
export interface ToolIOCost {
  readonly name: string
  readonly calls: number
  readonly results: number
  readonly estimatedCallTokens: number
  readonly estimatedResultTokens: number
  readonly estimatedTokens: number
}

export interface ToolIOAnalysis {
  readonly totalCalls: number
  readonly totalResults: number
  readonly estimatedTokens: number
  readonly ranked: readonly ToolIOCost[]
  readonly note: string
}

export interface ToolsAnalysis {
  readonly total: number
  readonly estimatedTokens: number
  readonly ranked: readonly ToolCost[]
  readonly groups: readonly ToolGroupTotal[]
  readonly source: "context-hook-request-snapshot"
  readonly attributionNote: string
  readonly io: ToolIOAnalysis
}

export interface Totals {
  readonly estimatedInputTokens: number
  readonly systemTokens: number
  readonly messageTokens: number
  readonly toolTokens: number
}

export interface Analysis {
  readonly version: 1
  readonly sessionID: string
  readonly agent: string
  readonly model: ModelRef
  readonly capturedAt: number
  readonly scope: {
    readonly hook: "context"
    readonly kinds: readonly ["primary"]
    readonly note: string
  }
  readonly estimation: {
    readonly method: "heuristic-local"
    readonly latinCharsPerToken: number
    readonly cjkCharsPerToken: number
    readonly remoteCalls: false
    readonly note: string
  }
  readonly system: SystemAnalysis
  readonly messages: MessagesAnalysis
  readonly tools: ToolsAnalysis
  readonly totals: Totals
  readonly limits: readonly string[]
}

const ROLE_ORDER = ["system", "user", "assistant", "tool"] as const

export const SCOPE_NOTE =
  'Observes the "context" hook only (the primary agent loop, including tool-driven continuations). Title, compaction, and transient generate requests are separate hooks and are not captured.'

export const ESTIMATION_NOTE =
  "Estimates are local character-ratio heuristics (not a model tokenizer). Provider-reported token counts are shown separately in the report's reported section."

export const PROVENANCE_NOTE =
  "System parts carry freeform metadata with no reliable per-file provenance in the V2 context hook; AGENTS.md/instructions file attribution is unavailable and every part is labeled unattributed."

export const TOOLS_ATTRIBUTION_NOTE =
  'Tool totals cover only the direct per-tool definitions in the request snapshot. Code Mode catalog/schema text embedded in instructions or messages is counted under system/messages, not here; do not read this total as "all schema overhead". MCP grouping is a heuristic effective-name prefix match against configured MCP server names; builtin and plugin tools are grouped as "other".'

export const TOOL_IO_NOTE =
  "Per-tool I/O is estimated from tool-call and tool-result parts in the transcript (keyed by the transcript part name). It is a subset of the messages total, not an addition: do not add it on top of the estimated input total. The per-request schema footprint is counted separately in the request's tools map."

export const ANALYSIS_LIMITS: readonly string[] = [
  ESTIMATION_NOTE,
  PROVENANCE_NOTE,
  TOOLS_ATTRIBUTION_NOTE,
  TOOL_IO_NOTE,
  "Media parts and encrypted reasoning/compaction payloads are counted but not token-estimated.",
  "Per-message protocol overhead (message wrappers, cache-control markers) is not included in estimates.",
  "Auxiliary model requests (title, compaction, generate) are not captured by the context hook.",
]

// ---------------------------------------------------------------------------
// Tool grouping (heuristic)
// ---------------------------------------------------------------------------

/**
 * Heuristic: an effective tool id `name_tool` is attributed to the MCP server
 * `name` when that server is configured. Longest server-name match wins so
 * `docs` does not shadow `docs_extra`. Everything else (builtin and plugin
 * tools, which use the same `namespace_tool` shape) is grouped as "other".
 */
export function groupForToolID(id: string, servers: readonly string[]): ToolGroup {
  let best: string | undefined
  for (const server of servers) {
    if (typeof server !== "string" || server.length === 0) continue
    if (id === server || id.startsWith(`${server}_`)) {
      if (best === undefined || server.length > best.length) best = server
    }
  }
  return best === undefined
    ? { kind: "other", name: "other", attribution: "none" }
    : { kind: "mcp-server", name: best, attribution: "heuristic-prefix" }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface PartResult {
  readonly partType: string
  readonly estimatedTokens: number
  readonly characters: number
  readonly countedOnly: boolean
  readonly note?: string
  readonly toolName?: string
  readonly ioKind?: "call" | "result"
}

function mediaCharacters(media: unknown): number {
  if (typeof media !== "object" || media === null) return 0
  const source = (media as { source?: unknown }).source
  if (typeof source !== "object" || source === null) return 0
  const s = source as { type?: unknown; data?: unknown; url?: unknown; id?: unknown }
  if (typeof s.data === "string") return s.data.length
  if (Array.isArray(s.data)) return s.data.length
  if (typeof s.url === "string") return s.url.length
  if (typeof s.id === "string") return s.id.length
  return 0
}

/** Exact serialized length of a JSON value; cycle-safe fallback. No truncation: sizes must stay accurate. */
function serializedLength(value: unknown): number {
  try {
    const out = JSON.stringify(value)
    return typeof out === "string" ? out.length : 0
  } catch {
    return serializeJson(value).length
  }
}

function analyzePart(part: unknown, ratios: EstimateRatios): PartResult {
  if (typeof part !== "object" || part === null || typeof (part as { type?: unknown }).type !== "string") {
    return { partType: "other", estimatedTokens: 0, characters: 0, countedOnly: true, note: "unrecognized part shape" }
  }
  const p = part as Record<string, unknown>
  switch (p.type) {
    case "text": {
      const text = typeof p.text === "string" ? p.text : ""
      return { partType: "text", estimatedTokens: estimateTextTokens(text, ratios), characters: text.length, countedOnly: false }
    }
    case "media": {
      // Media payloads are not text; count size only (no token estimate).
      const characters = mediaCharacters(p.media)
      return { partType: "media", estimatedTokens: 0, characters, countedOnly: true, note: "media counted by payload size; not token-estimated" }
    }
    case "tool-call": {
      const name = typeof p.name === "string" ? p.name : ""
      const callTokens = estimateTextTokens(name, ratios) + estimateJsonTokens(p.input, ratios)
      const characters = name.length + serializedLength(p.input)
      return { partType: "tool-call", estimatedTokens: callTokens, characters, countedOnly: false, toolName: name || "(unnamed)", ioKind: "call" }
    }
    case "tool-result": {
      const name = typeof p.name === "string" ? p.name : ""
      const result = p.result
      const value = typeof result === "object" && result !== null && "value" in result ? (result as { value: unknown }).value : result
      const callTokens = estimateTextTokens(name, ratios) + estimateJsonTokens(value, ratios)
      const characters = name.length + serializedLength(value)
      return { partType: "tool-result", estimatedTokens: callTokens, characters, countedOnly: false, toolName: name || "(unnamed)", ioKind: "result" }
    }
    case "reasoning": {
      if (typeof p.text === "string" && p.text.length > 0) {
        return { partType: "reasoning", estimatedTokens: estimateTextTokens(p.text, ratios), characters: p.text.length, countedOnly: false }
      }
      const encrypted = typeof p.encrypted === "string" ? p.encrypted : ""
      return { partType: "reasoning", estimatedTokens: 0, characters: encrypted.length, countedOnly: true, note: "encrypted payload; length only" }
    }
    case "compaction": {
      if (typeof p.text === "string") {
        return { partType: "compaction", estimatedTokens: estimateTextTokens(p.text, ratios), characters: p.text.length, countedOnly: false }
      }
      const encrypted = typeof p.encrypted === "string" ? p.encrypted : ""
      return { partType: "compaction", estimatedTokens: 0, characters: encrypted.length, countedOnly: true, note: "encrypted payload; length only" }
    }
    case "effort": {
      // Effort markers carry no text content.
      return { partType: "effort", estimatedTokens: 0, characters: 0, countedOnly: false, note: "structural marker" }
    }
    default:
      return { partType: String(p.type), estimatedTokens: 0, characters: 0, countedOnly: true, note: "unrecognized part type" }
  }
}

/** Accumulator for per-part-type buckets; owns the `parts` count from the first insert. */
interface PartTypeAccumulator {
  readonly partType: string
  parts: number
  estimatedTokens: number
  characters: number
  countedOnly: boolean
  note?: string
}

function share(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((value / total) * 10_000) / 10_000
}

const CATEGORY_ORDER: readonly MessageCategory[] = ["user-text", "assistant-text", "other-text", "reasoning", "tool-io", "media", "other"]

function categorize(role: string, partType: string): MessageCategory {
  switch (partType) {
    case "text":
      if (role === "user") return "user-text"
      if (role === "assistant") return "assistant-text"
      return "other-text"
    case "reasoning":
      return "reasoning"
    case "tool-call":
    case "tool-result":
      return "tool-io"
    case "media":
      return "media"
    default:
      return "other"
  }
}

export function analyzeContextEvent(event: ContextEventLike, options: AnalyzeOptions = {}): Analysis {
  const ratios = options.ratios ?? defaultRatios
  const now = options.now ?? (() => Date.now())
  const servers = options.mcpServers ?? []
  const maxRanked = options.maxRankedTools ?? 12
  const maxLargest = options.maxLargestMessages ?? 5

  // --- system ---
  let systemTokens = 0
  let systemCharacters = 0
  let cacheHinted = 0
  const systemParts = Array.isArray(event.system) ? event.system : []
  for (const part of systemParts) {
    const text = typeof part?.text === "string" ? part.text : ""
    systemTokens += estimateTextTokens(text, ratios)
    systemCharacters += text.length
    if (part && (part as { cache?: unknown }).cache !== undefined) cacheHinted += 1
  }

  // --- messages ---
  const roleMap = new Map<string, { messages: number; parts: number; tokens: number; characters: number }>()
  const partMap = new Map<string, PartTypeAccumulator>()
  const categoryMap = new Map<MessageCategory, { parts: number; tokens: number }>()
  const toolIOMap = new Map<string, { name: string; calls: number; results: number; callTokens: number; resultTokens: number }>()
  const messages = Array.isArray(event.messages) ? event.messages : []
  const sizes: MessageSize[] = []
  messages.forEach((message, index) => {
    const role = typeof (message as { role?: unknown })?.role === "string" ? (message as { role: string }).role : "unknown"
    const content = Array.isArray((message as { content?: unknown })?.content) ? (message as { content: unknown[] }).content : []
    let messageTokens = 0
    let messageCharacters = 0
    for (const rawPart of content) {
      const result = analyzePart(rawPart, ratios)
      messageTokens += result.estimatedTokens
      messageCharacters += result.characters
      const existing = partMap.get(result.partType)
      if (existing) {
        existing.parts += 1
        existing.estimatedTokens += result.estimatedTokens
        existing.characters += result.characters
        existing.countedOnly = existing.countedOnly && result.countedOnly
        if (existing.note === undefined && result.note !== undefined) existing.note = result.note
      } else {
        partMap.set(result.partType, {
          partType: result.partType,
          parts: 1,
          estimatedTokens: result.estimatedTokens,
          characters: result.characters,
          countedOnly: result.countedOnly,
          ...(result.note !== undefined ? { note: result.note } : {}),
        })
      }
      const category = categorize(role, result.partType)
      const categoryEntry = categoryMap.get(category) ?? { parts: 0, tokens: 0 }
      categoryMap.set(category, { parts: categoryEntry.parts + 1, tokens: categoryEntry.tokens + result.estimatedTokens })
      if (result.toolName !== undefined && result.ioKind !== undefined) {
        const io = toolIOMap.get(result.toolName) ?? { name: result.toolName, calls: 0, results: 0, callTokens: 0, resultTokens: 0 }
        if (result.ioKind === "call") {
          io.calls += 1
          io.callTokens += result.estimatedTokens
        } else {
          io.results += 1
          io.resultTokens += result.estimatedTokens
        }
        toolIOMap.set(result.toolName, io)
      }
    }
    const roleEntry = roleMap.get(role) ?? { messages: 0, parts: 0, tokens: 0, characters: 0 }
    roleMap.set(role, {
      messages: roleEntry.messages + 1,
      parts: roleEntry.parts + content.length,
      tokens: roleEntry.tokens + messageTokens,
      characters: roleEntry.characters + messageCharacters,
    })
    sizes.push({ index, role, parts: content.length, estimatedTokens: messageTokens, characters: messageCharacters })
  })

  const byRole: RoleBreakdown[] = []
  for (const role of ROLE_ORDER) {
    const entry = roleMap.get(role)
    if (entry) byRole.push({ role, messages: entry.messages, parts: entry.parts, estimatedTokens: entry.tokens, characters: entry.characters })
  }
  for (const [role, entry] of [...roleMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!ROLE_ORDER.includes(role as (typeof ROLE_ORDER)[number])) {
      byRole.push({ role, messages: entry.messages, parts: entry.parts, estimatedTokens: entry.tokens, characters: entry.characters })
    }
  }

  const byPartType: PartTypeBreakdown[] = [...partMap.values()]
    .map(entry => ({
      partType: entry.partType,
      parts: entry.parts,
      estimatedTokens: entry.estimatedTokens,
      characters: entry.characters,
      countedOnly: entry.countedOnly,
      ...(entry.note !== undefined ? { note: entry.note } : {}),
    }))
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens || b.parts - a.parts || a.partType.localeCompare(b.partType))

  const messageTokens = byRole.reduce((sum, entry) => sum + entry.estimatedTokens, 0)

  const categories: CategoryBreakdown[] = CATEGORY_ORDER.flatMap(category => {
    const entry = categoryMap.get(category)
    if (!entry) return []
    return [{ category, parts: entry.parts, estimatedTokens: entry.tokens }]
  })

  const largest = [...sizes]
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.index - b.index)
    .slice(0, Math.max(0, maxLargest))
    .map(({ index, role, parts, estimatedTokens, characters }) => ({ index, role, parts, estimatedTokens, characters }))

  // --- tools: the direct request snapshot from the hook (never ctx.tool.list()) ---
  const toolsRecord = (event.tools && typeof event.tools === "object" ? event.tools : {}) as Record<string, { description?: unknown; input?: unknown }>
  const toolCosts: ToolCost[] = Object.entries(toolsRecord).map(([id, tool]) => {
    const description = typeof tool?.description === "string" ? tool.description : ""
    const schemaCharacters = serializedLength(tool?.input)
    const properties =
      tool?.input && typeof tool.input === "object" && typeof (tool.input as { properties?: unknown }).properties === "object"
        ? Object.keys((tool.input as { properties: Record<string, unknown> }).properties).length
        : 0
    return {
      id,
      estimatedTokens: estimateTextTokens(description, ratios) + estimateJsonTokens(tool?.input, ratios),
      descriptionCharacters: description.length,
      schemaCharacters,
      schemaProperties: properties,
      group: groupForToolID(id, servers),
    }
  })
  toolCosts.sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.id.localeCompare(b.id))
  const toolTokens = toolCosts.reduce((sum, tool) => sum + tool.estimatedTokens, 0)

  const toolIORanked: ToolIOCost[] = [...toolIOMap.values()]
    .map(io => ({
      name: io.name,
      calls: io.calls,
      results: io.results,
      estimatedCallTokens: io.callTokens,
      estimatedResultTokens: io.resultTokens,
      estimatedTokens: io.callTokens + io.resultTokens,
    }))
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, maxRanked))
  const toolIOTokens = [...toolIOMap.values()].reduce((sum, io) => sum + io.callTokens + io.resultTokens, 0)

  interface GroupAccumulator {
    name: string
    kind: "mcp-server" | "other"
    tools: number
    attribution: ToolGroupAttribution
    tokenAccumulator: number
  }
  const groupMap = new Map<string, GroupAccumulator>()
  for (const tool of toolCosts) {
    const entry = groupMap.get(tool.group.name) ?? {
      name: tool.group.name,
      kind: tool.group.kind,
      tools: 0,
      attribution: tool.group.attribution,
      tokenAccumulator: 0,
    }
    entry.tools += 1
    entry.tokenAccumulator += tool.estimatedTokens
    groupMap.set(tool.group.name, entry)
  }
  const groups: ToolGroupTotal[] = [...groupMap.values()]
    .map(({ tokenAccumulator, name, kind, tools, attribution }) => ({
      name,
      kind,
      tools,
      estimatedTokens: tokenAccumulator,
      share: share(tokenAccumulator, toolTokens),
      attribution,
    }))
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.name.localeCompare(b.name))

  const estimatedInputTokens = systemTokens + messageTokens + toolTokens

  return {
    version: 1,
    sessionID: event.sessionID,
    agent: event.agent,
    model: { providerID: event.model.providerID, id: event.model.id, variant: event.model.variant },
    capturedAt: now(),
    scope: { hook: "context", kinds: ["primary"], note: SCOPE_NOTE },
    estimation: {
      method: "heuristic-local",
      latinCharsPerToken: ratios.latinCharsPerToken,
      cjkCharsPerToken: ratios.cjkCharsPerToken,
      remoteCalls: false,
      note: ESTIMATION_NOTE,
    },
    system: {
      parts: systemParts.length,
      characters: systemCharacters,
      estimatedTokens: systemTokens,
      cacheHintedParts: cacheHinted,
      provenance: { available: false, sources: [], note: PROVENANCE_NOTE },
    },
    messages: { total: messages.length, byRole, byPartType, categories, largest },
    tools: {
      total: toolCosts.length,
      estimatedTokens: toolTokens,
      ranked: toolCosts.slice(0, Math.max(0, maxRanked)).map(tool => ({ ...tool })),
      groups,
      source: "context-hook-request-snapshot",
      attributionNote: TOOLS_ATTRIBUTION_NOTE,
      io: {
        totalCalls: [...toolIOMap.values()].reduce((sum, io) => sum + io.calls, 0),
        totalResults: [...toolIOMap.values()].reduce((sum, io) => sum + io.results, 0),
        estimatedTokens: toolIOTokens,
        ranked: toolIORanked,
        note: TOOL_IO_NOTE,
      },
    },
    totals: {
      estimatedInputTokens,
      systemTokens,
      messageTokens,
      toolTokens,
    },
    limits: ANALYSIS_LIMITS,
  }
}
