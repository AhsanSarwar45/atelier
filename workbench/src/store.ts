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

  // A read cache only. The record of who touched what lives on the board, in
  // bd's provenance log; these two tables must always be rebuildable from it.
  `CREATE TABLE bead_link (
     session_id TEXT NOT NULL,
     bead_id TEXT NOT NULL,
     via TEXT NOT NULL,
     first_seen_at TEXT NOT NULL,
     PRIMARY KEY (session_id, bead_id)
   );
   CREATE TABLE report_link (
     session_id TEXT NOT NULL,
     project TEXT NOT NULL,
     slug TEXT NOT NULL,
     at TEXT NOT NULL,
     PRIMARY KEY (session_id, project, slug)
   );`,

  // What was said, and what it cost. Both are folded from the event log rather
  // than being a second source of truth: `message` is the deltas of one message
  // joined up so a sentence split across twenty of them can still be found, and
  // `turn` is the cost each turn reported, kept in the unit the brand reported
  // it in — dollars and tokens are never added together (decision 12).
  `CREATE TABLE message (
     session_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     at TEXT NOT NULL,
     PRIMARY KEY (session_id, message_id)
   );
   CREATE INDEX message_by_session ON message(session_id, at);
   CREATE TABLE turn (
     session_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     brand TEXT NOT NULL,
     day TEXT NOT NULL,
     at TEXT NOT NULL,
     usd REAL,
     input INTEGER,
     output INTEGER,
     total INTEGER,
     PRIMARY KEY (session_id, at)
   );
   CREATE INDEX turn_by_day ON turn(day, project_id);`,
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

  /**
   * Carries `origin` as well: where a conversation began does not change
   * because the app later took it over, and the restore list says so.
   */
  listSessions(projectId?: string): (SessionSummary & { origin: 'app' | 'terminal' })[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM session WHERE project_id = ? ORDER BY last_active_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM session ORDER BY last_active_at DESC').all();
    return (rows as Record<string, string>[]).map((r) => ({
      ...rowToSummary(r),
      origin: r.origin === 'terminal' ? 'terminal' : 'app',
    }));
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

  /**
   * On boot nothing is running, whatever the last write claimed. A row saying
   * `streaming` after a restart would promise a process that does not exist.
   */
  markAllDormant(): void {
    this.db.prepare("UPDATE session SET state = 'dormant' WHERE state NOT IN ('ended','dormant')").run();
  }

  rememberBeadLink(sessionId: string, beadId: string, via: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO bead_link (session_id, bead_id, via, first_seen_at) VALUES (?,?,?,?)')
      .run(sessionId, beadId, via, new Date().toISOString());
  }

  rememberReportLink(sessionId: string, project: string, slug: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO report_link (session_id, project, slug, at) VALUES (?,?,?,?)')
      .run(sessionId, project, slug, new Date().toISOString());
  }

  beadsForSession(sessionId: string): string[] {
    return (
      this.db.prepare('SELECT bead_id FROM bead_link WHERE session_id = ? ORDER BY first_seen_at').all(sessionId) as {
        bead_id: string;
      }[]
    ).map((r) => r.bead_id);
  }

  /** Sessions this bead is linked to, newest first — the cache side of the join. */
  sessionsForBead(beadId: string): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM bead_link b JOIN session s ON s.id = b.session_id
         WHERE b.bead_id = ? ORDER BY s.last_active_at DESC`,
      )
      .all(beadId) as Record<string, string>[];
    return rows.map(rowToSummary);
  }

  /** How much has been said in a chat — 0 is one that was opened and never used. */
  messageCount(sessionId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return r.n;
  }

  /** Starts a message, so the deltas that follow have something to grow. */
  openMessage(sessionId: string, messageId: string, role: string, at: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO message (session_id, message_id, role, text, at) VALUES (?,?,?,?,?)')
      .run(sessionId, messageId, role, '', at);
  }

  /** Grows a message by one delta. */
  growMessage(sessionId: string, messageId: string, text: string): void {
    this.db
      .prepare('UPDATE message SET text = text || ? WHERE session_id = ? AND message_id = ?')
      .run(text, sessionId, messageId);
  }

  /** What one turn cost, in the unit the brand reported. */
  rememberTurn(row: {
    sessionId: string;
    projectId: string;
    brand: string;
    at: string;
    usd: number | null;
    input: number | null;
    output: number | null;
    total: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO turn (session_id, project_id, brand, day, at, usd, input, output, total)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(row.sessionId, row.projectId, row.brand, row.at.slice(0, 10), row.at,
           row.usd, row.input, row.output, row.total);
  }

  /**
   * Messages holding `q`, newest first. LIKE rather than a full-text index:
   * the corpus is one owner's conversations, and this is revisited if it ever
   * reaches tens of thousands (docs/agent-workbench.md §9.3).
   */
  search(q: string, limit = 100): { sessionId: string; messageId: string; role: string; text: string; at: string }[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, message_id, role, text, at FROM message
         WHERE text LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT ?`,
      )
      .all('%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%', limit) as Record<string, string>[];
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      messageId: r.message_id as string,
      role: r.role as string,
      text: r.text as string,
      at: r.at as string,
    }));
  }

  /** One row per project per day per brand — never summed across brands. */
  spend(): { day: string; projectId: string; brand: string; usd: number; tokens: number }[] {
    const rows = this.db
      .prepare(
        `SELECT day, project_id, brand,
                COALESCE(SUM(usd), 0) AS usd,
                COALESCE(SUM(total), 0) AS tokens
         FROM turn GROUP BY day, project_id, brand ORDER BY day`,
      )
      .all() as Record<string, string | number>[];
    return rows.map((r) => ({
      day: r.day as string,
      projectId: r.project_id as string,
      brand: r.brand as string,
      usd: Number(r.usd),
      tokens: Number(r.tokens),
    }));
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
