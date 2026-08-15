/**
 * The workbench's own SQLite file. The sidecar is its only writer.
 *
 * Kept apart from the server's settings.db so no upstream Rust touches it,
 * and so a schema change here can never break the board.
 *
 * The `event` table IS the transcript: opening a chat replays it from seq 0
 * and then tails live, so history and the live stream are one code path
 * (docs/agent-workbench.md §4).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import type { SessionSummary, WbpEvent } from '../../src/workbench/protocol.ts';

/**
 * Beside the server's own settings.db: `directories`' data_dir on Linux is
 * `$XDG_DATA_HOME/kanban-ui`, which is what server/src/db.rs resolves to.
 * Both must move together when XDG_DATA_HOME is redirected.
 */
function defaultDbPath(): string {
  if (process.env.BEADS_WORKBENCH_DB) return process.env.BEADS_WORKBENCH_DB;
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'kanban-ui', 'workbench.db');
}

/** Numbered and applied in order above the recorded version, matching the idiom in server/src/db.rs. */
const MIGRATIONS: string[] = [
  `CREATE TABLE session (
     id TEXT PRIMARY KEY,
     brand TEXT NOT NULL,
     external_id TEXT,
     project_id TEXT NOT NULL,
     project_path TEXT NOT NULL,
     cwd TEXT NOT NULL,
     model TEXT,
     permission_mode TEXT NOT NULL,
     title TEXT,
     state TEXT NOT NULL,
     origin TEXT NOT NULL,
     created_at TEXT NOT NULL,
     last_active_at TEXT NOT NULL,
     ended_at TEXT
   );
   CREATE TABLE event (
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at TEXT NOT NULL,
     type TEXT NOT NULL,
     json TEXT NOT NULL,
     PRIMARY KEY (session_id, seq)
   );
   CREATE INDEX event_by_session ON event(session_id, seq);`,
];

export class Store {
  private db: DatabaseSync;

  constructor(path = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (row === undefined) this.db.prepare('INSERT INTO schema_version VALUES (0)').run();
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]!);
      version = i + 1;
    }
    this.db.prepare('UPDATE schema_version SET version = ?').run(version);
  }

  createSession(s: SessionSummary & { origin: string }): void {
    this.db
      .prepare(
        `INSERT INTO session (id, brand, external_id, project_id, project_path, cwd, model,
           permission_mode, title, state, origin, created_at, last_active_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id, s.brand, s.externalId, s.projectId, s.projectPath, s.cwd, s.model,
        s.permissionMode, s.title, s.state, s.origin, s.createdAt, s.lastActiveAt,
      );
  }

  updateSession(id: string, patch: Partial<Pick<SessionSummary, 'externalId' | 'title' | 'state' | 'model'>>): void {
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    if ('externalId' in patch) { sets.push('external_id = ?'); vals.push(patch.externalId ?? null); }
    if ('title' in patch) { sets.push('title = ?'); vals.push(patch.title ?? null); }
    if ('state' in patch) { sets.push('state = ?'); vals.push(patch.state ?? null); }
    if ('model' in patch) { sets.push('model = ?'); vals.push(patch.model ?? null); }
    sets.push('last_active_at = ?');
    vals.push(new Date().toISOString());
    this.db.prepare(`UPDATE session SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  getSession(id: string): SessionSummary | undefined {
    const r = this.db.prepare('SELECT * FROM session WHERE id = ?').get(id) as Record<string, string> | undefined;
    return r ? rowToSummary(r) : undefined;
  }

  listSessions(projectId?: string): SessionSummary[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM session WHERE project_id = ? ORDER BY last_active_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM session ORDER BY last_active_at DESC').all();
    return (rows as Record<string, string>[]).map(rowToSummary);
  }

  /** Next seq for a session. The event log is the only place seq is allocated. */
  nextSeq(sessionId: string): number {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM event WHERE session_id = ?')
      .get(sessionId) as { m: number };
    return r.m + 1;
  }

  appendEvent(e: WbpEvent): void {
    this.db
      .prepare('INSERT INTO event (session_id, seq, at, type, json) VALUES (?,?,?,?,?)')
      .run(e.sessionId, e.seq, e.at, e.type, JSON.stringify(e));
  }

  /** Every event after `since`, in order — the replay half of the SSE stream. */
  eventsSince(sessionId: string, since: number): WbpEvent[] {
    const rows = this.db
      .prepare('SELECT json FROM event WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, since) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as WbpEvent);
  }
}

function rowToSummary(r: Record<string, unknown>): SessionSummary {
  return {
    id: r.id as string,
    brand: r.brand as SessionSummary['brand'],
    externalId: (r.external_id as string) ?? null,
    projectId: r.project_id as string,
    projectPath: r.project_path as string,
    cwd: r.cwd as string,
    model: (r.model as string) ?? null,
    permissionMode: r.permission_mode as string,
    title: (r.title as string) ?? null,
    state: r.state as SessionSummary['state'],
    createdAt: r.created_at as string,
    lastActiveAt: r.last_active_at as string,
  };
}
