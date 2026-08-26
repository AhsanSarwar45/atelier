/**
 * `node:sqlite` as this project's @types/node (20.x) does not yet describe it.
 *
 * The sidecar's store is built on it and runs under Node's strip-only mode,
 * which never typechecks; this declaration exists so a test in the app's own
 * suite can open a real store and prove what survives a chat being read again
 * (src/workbench/__tests__/imported-log.test.ts). It is deliberately the smallest
 * shape those tests touch — the runtime is the authority, not this file.
 */
declare module 'node:sqlite' {
  export class StatementSync {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  }

  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
