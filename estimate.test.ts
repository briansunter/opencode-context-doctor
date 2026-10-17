import test from "node:test"
import assert from "node:assert/strict"
import { countCharacters, estimateJsonTokens, estimateTextTokens, serializeJson, defaultRatios } from "./estimate.ts"

test("empty text estimates to zero tokens", () => {
  assert.equal(estimateTextTokens(""), 0)
})

test("latin text uses the chars-per-token ratio", () => {
  // 11 chars / 4 = 2.75 -> ceil 3
  assert.equal(estimateTextTokens("hello world"), 3)
  assert.equal(estimateTextTokens("hello world", { latinCharsPerToken: 2, cjkCharsPerToken: 1 }), 6)
})

test("cjk text uses the cjk ratio", () => {
  // 2 CJK chars / 1.5 = 1.33 -> ceil 2
  assert.equal(estimateTextTokens("你好"), 2)
})

test("mixed text splits by script", () => {
  // 2 CJK / 1.5 + 2 latin / 4 = 1.333 + 0.5 = 1.833 -> ceil 2
  assert.equal(estimateTextTokens("hi你好"), 2)
})

test("countCharacters counts code points", () => {
  const counts = countCharacters("a😀你")
  assert.equal(counts.total, 3)
  assert.equal(counts.cjk, 1)
})

test("estimation is monotonic in length", () => {
  const short = estimateTextTokens("token")
  const long = estimateTextTokens("token ".repeat(100))
  assert.ok(long > short)
})

test("default ratios are frozen and sane", () => {
  assert.equal(defaultRatios.latinCharsPerToken, 4)
  assert.equal(defaultRatios.cjkCharsPerToken, 1.5)
})

test("serializeJson handles cycles without throwing", () => {
  const value: Record<string, unknown> = { name: "x" }
  value.self = value
  const out = serializeJson(value)
  assert.ok(out.includes("[circular]"))
})

test("serializeJson caps pathological sizes", () => {
  const big = "x".repeat(1_000_000)
  assert.equal(serializeJson({ data: big }).length, 400_000)
})

test("estimateJsonTokens is deterministic and content-order-sensitive", () => {
  const a = estimateJsonTokens({ a: 1, b: [1, 2, 3] })
  const b = estimateJsonTokens({ a: 1, b: [1, 2, 3] })
  const c = estimateJsonTokens({ a: 1, b: [1, 2, 3, 4, 5, 6] })
  assert.equal(a, b)
  assert.ok(c > a)
})
