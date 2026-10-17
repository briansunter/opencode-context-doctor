/**
 * Minimal ambient types for Bun's built-in SQLite driver.
 *
 * The OpenCode server runs plugins under Bun, where `bun:sqlite` is always
 * available - but it is synchronous-only, so this plugin touches it solely
 * inside the persistence worker thread (never on the main/event-loop thread).
 * These declarations cover only the surface the worker uses; `tsc --noEmit`
 * runs against @types/node, which has no bun:sqlite types.
 */
declare module "bun:sqlite" {
  export interface SqliteStatement {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }

  export class Database {
    constructor(path: string, options?: number | { readonly?: boolean; create?: boolean })
    exec(sql: string, ...params: unknown[]): void
    query(sql: string): SqliteStatement
    prepare(sql: string): SqliteStatement
    close(): void
  }
}
