/**
 * Location matching for the unfiltered public event stream.
 *
 * Each location's plugin instance receives every public server event, so the
 * plugin must filter events by location before applying them. Events without
 * a verifiable location are ignored (fail closed).
 */

export interface PluginLocation {
  readonly directory: string
  readonly workspaceID?: string
}

export function locationMatches(event: unknown, plugin: PluginLocation): boolean {
  if (typeof event !== "object" || event === null) return false
  const e = event as { directory?: unknown; workspaceID?: unknown }
  if (typeof e.directory !== "string" || e.directory.length === 0) return false
  if (e.directory !== plugin.directory) return false
  if (plugin.workspaceID !== undefined && typeof e.workspaceID === "string" && e.workspaceID !== plugin.workspaceID) {
    return false
  }
  return true
}
