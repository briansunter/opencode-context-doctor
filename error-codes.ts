/**
 * Closed vocabulary for stored error codes.
 *
 * Free-form error messages can echo serialized content (paths, schema
 * fragments) when an accessor throws, so the plugin stores only these fixed
 * codes. Full diagnostics go to the OpenCode plugin log, never to storage or
 * RPC payloads.
 */
export const HOOK_ERROR_CODES = ["analysis-failed"] as const

export type HookErrorCode = (typeof HOOK_ERROR_CODES)[number]

/**
 * Closed vocabulary for persistence-layer error codes (same privacy rule as
 * hook errors: never free-form messages - SQL/driver errors can echo paths
 * or serialized fragments, so only these fixed codes are stored or emitted).
 */
export const PERSIST_ERROR_CODES = [
  "worker-spawn-failed",
  "db-open-failed",
  "db-corrupt",
  "init-failed",
  "flush-failed",
  "busy-timeout",
  "hydrate-failed",
  "payload-invalid",
  "query-failed",
  "health-unavailable",
  "timeout",
  "disabled",
] as const

export type PersistErrorCode = (typeof PERSIST_ERROR_CODES)[number]

export function isHookErrorCode(value: string): value is HookErrorCode {
  return (HOOK_ERROR_CODES as readonly string[]).includes(value)
}
