/**
 * Local, deterministic token-estimation primitives.
 *
 * The plugin never downloads, embeds, or calls a tokenizer. Every number
 * produced from this module is a cheap character-ratio heuristic and is
 * labeled as an estimate everywhere it is surfaced. Provider-reported token
 * counts (when available) are always kept separate; see usage.ts / enrich.ts.
 */

export interface EstimateRatios {
  /** Average characters per token for whitespace-delimited scripts. */
  readonly latinCharsPerToken: number
  /** Average characters per token for CJK character ranges. */
  readonly cjkCharsPerToken: number
}

export const defaultRatios: EstimateRatios = Object.freeze({
  latinCharsPerToken: 4,
  cjkCharsPerToken: 1.5,
})

/** Serialization cap: keeps estimates cheap on pathological schemas without allocating unbounded strings. */
export const maxSerializedCharacters = 400_000

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // Hiragana / Katakana
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0x20000, 0x2a6df], // CJK extension B
]

export function isCJKChar(code: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => code >= lo && code <= hi)
}

export interface CharacterCounts {
  readonly total: number
  readonly cjk: number
}

export function countCharacters(text: string): CharacterCounts {
  let cjk = 0
  let total = 0
  for (const char of text) {
    total += 1
    const code = char.codePointAt(0) ?? 0
    if (isCJKChar(code)) cjk += 1
  }
  return { total, cjk }
}

export function estimateTextTokens(text: string, ratios: EstimateRatios = defaultRatios): number {
  if (text.length === 0) return 0
  const { total, cjk } = countCharacters(text)
  const other = total - cjk
  return Math.ceil(cjk / ratios.cjkCharsPerToken + other / ratios.latinCharsPerToken)
}

/**
 * Deterministic JSON serialization with a cycle guard and a size cap.
 * Returns "" for values that cannot be serialized.
 */
export function serializeJson(value: unknown): string {
  const seen = new WeakSet<object>()
  let out: string
  try {
    out = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString()
      if (typeof item !== "object" || item === null) return item
      if (seen.has(item)) return "[circular]"
      seen.add(item)
      return item
    })
  } catch {
    return ""
  }
  if (typeof out !== "string") return ""
  return out.length > maxSerializedCharacters ? out.slice(0, maxSerializedCharacters) : out
}

export function estimateJsonTokens(value: unknown, ratios: EstimateRatios = defaultRatios): number {
  return estimateTextTokens(serializeJson(value), ratios)
}
