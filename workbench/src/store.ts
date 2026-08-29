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

import { dataHome } from './data-home.ts';
import { boundedEvent } from './bounded-event.ts';
import { planCanonicalProjection, type CanonicalProjectionPlan } from './canonical-projection.ts';

import { EMPTY, foldAll, reduce, type SentAway, type TranscriptItem } from '../../src/workbench/fold.ts';
import type { SessionSummary, WbpEvent } from '../../src/workbench/protocol.ts';

/**
 * The helper's own records, beside the board's settings.
 *
 * Kept apart from the app's `settings.db` so no upstream Rust touches it, but
 * in the same folder, so redirecting where data goes moves both together.
 * Which folder that is, is `data-home.ts` and nothing here.
 */
function defaultDbPath(): string {
  if (process.env.BEADS_WORKBENCH_DB) return process.env.BEADS_WORKBENCH_DB;
  return join(dataHome(), 'workbench.db');
}

/**
 * The original positional migrations. This list is frozen: an ordinal is not
 * a stable identity once databases can pass between builds from different
 * branches. New runtime schema belongs in SCHEMA_CAPABILITIES below.
 */
const LEGACY_MIGRATIONS: string[] = [
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
  // bd's provenance log; this table must always be rebuildable from it.
  `CREATE TABLE bead_link (
     session_id TEXT NOT NULL,
     bead_id TEXT NOT NULL,
     via TEXT NOT NULL,
     first_seen_at TEXT NOT NULL,
     PRIMARY KEY (session_id, bead_id)
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

  // When a conversation's own record was read in, said plainly rather than
  // inferred. It used to be inferred from "has this chat any cards?", which is
  // false forever for a chat that touched none — so every open read the whole
  // conversation off the disk again and re-ran the card scan (bw-m8o.14).
  `ALTER TABLE session ADD COLUMN imported_at TEXT;`,

  // WHICH reading of the record a chat was read in by. Chats read in before
  // this were given their words and none of their commands, and a mark saying
  // only "read" left them that way forever — which is the copy the manager
  // photographed (bw-1u1, docs/agent-workbench.md §6.3.2).
  `ALTER TABLE session ADD COLUMN imported_recipe INTEGER;`,

  // When the PERSON last said something, beside the clock that moves for
  // everything. `last_active_at` is stamped by every event this app writes, so
  // a chat climbs the list all night while an agent works in it and the ones
  // the manager is talking in slide about under his cursor. Only `send` stamps
  // this one, and nothing else may (bw-zhs9).
  `ALTER TABLE session ADD COLUMN last_spoke_at TEXT;`,

  // Where a chat's record has been read up to, kept between opens. A chat
  // another program is driving is never finished being read, so every click
  // used to read the whole record again, throw the drawing away and publish it
  // afresh — seconds at a time, on exactly the chats the manager watches most.
  // The follower already reads from a byte and knows how many rows of what
  // stands there are drawn; remembering both turns every later open into "what
  // has arrived since" (bw-uiyz.19).
  `ALTER TABLE session ADD COLUMN followed_to INTEGER;
   ALTER TABLE session ADD COLUMN followed_drawn INTEGER;`,

  // How long each summarising run took, per project. The bar drawn over a
  // compaction fills against the median of these; until a project has enough of
  // its own it fills against the 124s measured across this machine
  // (bw-jaoz.14.9). Measured and not reported: the tool fires a hook as a
  // compaction begins and none as it ends, so the end is the beat on which the
  // chat stopped saying it was summarising.
  `CREATE TABLE summary_run (
     project TEXT NOT NULL,
     session_id TEXT NOT NULL,
     at TEXT NOT NULL,
     ms INTEGER NOT NULL,
     PRIMARY KEY (project, session_id, at)
   );
   CREATE INDEX summary_run_by_project ON summary_run(project, at);`,

  // Provider-neutral reasoning budget, nullable for conversations created by
  // providers or builds that did not report one.
  `ALTER TABLE session ADD COLUMN effort TEXT;`,

];

type SchemaCapability = {
  name: string;
  reconcile(db: DatabaseSync): void;
};

/**
 * Stable, named schema promises used by runtime code.
 *
 * The legacy migration counter only describes one linear history. Different
 * builds can legitimately arrive at the same counter through different
 * migrations, so the number cannot prove that a table has the shape runtime
 * code requires. Capabilities are therefore inspected and repaired on every
 * startup, inside the migration transaction. Add future runtime assumptions
 * here rather than relying on a new array position alone.
 */
const SCHEMA_CAPABILITIES: SchemaCapability[] = [
  {
    name: 'event.provider-identity.v1',
    reconcile(db) {
      // One logical provider event may arrive live, from a complete snapshot,
      // and again from the native record after this process restarts. Keep its
      // native identity beside the append-only JSON so the last boundary every
      // current and future provider crosses can enforce exactly-once ingestion.
      const columns = new Set(
        (db.prepare('PRAGMA table_info(event)').all() as Array<{ name: string }>).map((column) => column.name),
      );
      for (const column of ['provider', 'provider_thread_id', 'provider_event_id']) {
        if (!columns.has(column)) db.exec(`ALTER TABLE event ADD COLUMN ${column} TEXT`);
      }
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS event_by_provider_identity
           ON event(session_id, provider, provider_thread_id, provider_event_id)
           WHERE provider_event_id IS NOT NULL`,
      );
    },
  },
  {
    name: 'transcript-item-projection.v1',
    reconcile(db) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS transcript_item (
           session_id TEXT NOT NULL,
           item_key TEXT NOT NULL,
           position INTEGER NOT NULL,
           updated_seq INTEGER NOT NULL,
           visible INTEGER NOT NULL,
           json TEXT NOT NULL,
           PRIMARY KEY (session_id, item_key),
           UNIQUE (session_id, position)
         );
         CREATE INDEX IF NOT EXISTS transcript_item_page
           ON transcript_item(session_id, visible, position DESC);
         CREATE TABLE IF NOT EXISTS transcript_projection (
           session_id TEXT PRIMARY KEY,
           projected_seq INTEGER NOT NULL,
           reset_seq INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS transcript_agent (
           session_id TEXT NOT NULL,
           agent_id TEXT NOT NULL,
           tool_call_id TEXT,
           json TEXT NOT NULL,
           PRIMARY KEY (session_id, agent_id)
         );`,
      );
    },
  },
];

export interface TranscriptItemPage {
  items: TranscriptItem[];
  cursor: number | null;
  hasOlder: boolean;
  newestSeq: number;
}

const itemKey = (item: Pick<TranscriptItem, 'kind' | 'id'>): string => `${item.kind}:${item.id}`;

/** Diagnostic bookkeeping remains available in the event log, but it is not a
 * transcript row and cannot consume the fixed visible-item page budget. */
const itemIsVisible = (item: TranscriptItem): boolean => item.kind !== 'note' || item.rank !== 'detail';

export class Store {
  private db: DatabaseSync;

  constructor(path = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // A replacement helper can begin while the old process is finishing its
    // last write. With SQLite's default timeout of zero that ordinary overlap
    // escapes as "database is locked" and leaves every chat request failing
    // until the helper is restarted. Wait through the handoff instead.
    this.db.exec('PRAGMA busy_timeout = 10000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    // One helper owns schema inspection and changes as a unit. Without the
    // immediate transaction, two replacements can both observe version N and
    // race the same ALTER after the first lock clears.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
      const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
      let version = row?.version ?? 0;
      if (row === undefined) this.db.prepare('INSERT INTO schema_version VALUES (0)').run();
      for (let i = version; i < LEGACY_MIGRATIONS.length; i++) {
        this.db.exec(LEGACY_MIGRATIONS[i]!);
        version = i + 1;
      }
      for (const capability of SCHEMA_CAPABILITIES) {
        try {
          capability.reconcile(this.db);
        } catch (error) {
          throw new Error(`failed to reconcile schema capability ${capability.name}`, { cause: error });
        }
      }
      this.db.prepare('UPDATE schema_version SET version = ?').run(version);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* The failed statement may already have ended it. */ }
      throw error;
    }
  }

  close(): void { this.db.close(); }

  /**
   * One finished summarising run, written down as it ended.
   *
   * Keyed by the chat and the moment, so a beat seen twice cannot count the same
   * run twice. The project is its working directory: a held chat is known by
   * where it is running and by nothing else we could join on.
   */
  noteSummaryRun(run: { project: string; sessionId: string; at: number; ms: number }): void {
    this.db
      .prepare('INSERT OR REPLACE INTO summary_run (project, session_id, at, ms) VALUES (?,?,?,?)')
      .run(run.project, run.sessionId, new Date(run.at).toISOString(), Math.round(run.ms));
  }

  /**
   * How long this project's last runs took, newest first.
   *
   * Bounded because the estimate should follow the project as it grows: a
   * conversation that summarised in ninety seconds a month ago says little
   * about one summarising now.
   */
  summaryRuns(project: string, limit = 20): number[] {
    const rows = this.db
      .prepare('SELECT ms FROM summary_run WHERE project = ? ORDER BY at DESC LIMIT ?')
      .all(project, limit) as { ms: number }[];
    return rows.map((r) => r.ms);
  }

  createSession(s: SessionSummary & { origin: string }): void {
    this.db
      .prepare(
        `INSERT INTO session (id, brand, external_id, project_id, project_path, cwd, model,
           permission_mode, effort, title, state, origin, created_at, last_active_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id, s.brand, s.externalId, s.projectId, s.projectPath, s.cwd, s.model,
        s.permissionMode, s.effort ?? null, s.title, s.state, s.origin, s.createdAt, s.lastActiveAt,
      );
  }

  /**
   * `touch` is what puts the row at the top of the list. It is false for the
   * things that are not activity — a chat being read, and a chat falling
   * asleep — because the list is ordered by when a conversation last DID
   * something, and clicking one is not it (docs/designs/app-shell.md §1.9).
   */
  updateSession(
    id: string,
    patch: Partial<Pick<SessionSummary, 'externalId' | 'title' | 'state' | 'model' | 'permissionMode' | 'effort'>>,
    touch = true,
  ): void {
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    if ('externalId' in patch) { sets.push('external_id = ?'); vals.push(patch.externalId ?? null); }
    if ('title' in patch) { sets.push('title = ?'); vals.push(patch.title ?? null); }
    if ('state' in patch) { sets.push('state = ?'); vals.push(patch.state ?? null); }
    if ('model' in patch) { sets.push('model = ?'); vals.push(patch.model ?? null); }
    if ('permissionMode' in patch) { sets.push('permission_mode = ?'); vals.push(patch.permissionMode ?? null); }
    if ('effort' in patch) { sets.push('effort = ?'); vals.push(patch.effort ?? null); }
    if (touch) {
      sets.push('last_active_at = ?');
      vals.push(new Date().toISOString());
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE session SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  /**
   * The person said something. The one thing that moves the second clock.
   *
   * Kept out of `updateSession` on purpose: that one's `touch` is stamped by
   * every event this app writes, which is precisely the behaviour this exists
   * to sit beside. An agent's reply, its thinking, its question about a tool
   * and the cards it linked must all leave this untouched (bw-zhs9).
   */
  markSpoke(id: string, at: string = new Date().toISOString()): void {
    this.db.prepare('UPDATE session SET last_spoke_at = ? WHERE id = ?').run(at, id);
  }

  /**
   * The row for a conversation the brand knows by ITS id, whatever we call it.
   *
   * Opening one has to find it this way or a second click makes a second row,
   * with a second imported copy of the same history (bw-m8o.12).
   */
  sessionByExternalId(externalId: string): SessionSummary | undefined {
    const r = this.db
      .prepare('SELECT * FROM session WHERE external_id = ? ORDER BY last_active_at DESC LIMIT 1')
      .get(externalId) as Record<string, string> | undefined;
    return r ? rowToSummary(r) : undefined;
  }

  /**
   * Which reading of the record this chat was read in by, or null for a chat
   * never read in at all. A chat read in by a build that had no recipes at all
   * counts as recipe 0, so it is re-read once and then left alone.
   */
  importedBy(id: string): number | null {
    const r = this.db.prepare('SELECT imported_at, imported_recipe FROM session WHERE id = ?').get(id) as
      | { imported_at: string | null; imported_recipe: number | null }
      | undefined;
    if (!r) return null;
    if (r.imported_recipe !== null) return r.imported_recipe;
    return r.imported_at ? 0 : null;
  }

  importedAt(id: string): string | null {
    const row = this.db.prepare('SELECT imported_at FROM session WHERE id = ?').get(id) as { imported_at: string | null } | undefined;
    return row?.imported_at ?? null;
  }

  markImported(id: string, recipe: number): void {
    // The mark and the byte are set together, and the byte is cleared: a whole
    // record has just been read, so any byte an older follower stopped at is
    // behind what is now drawn and carrying on from it would say those lines
    // twice (bw-uiyz.19).
    this.db
      .prepare(
        'UPDATE session SET imported_at = ?, imported_recipe = ?, followed_to = NULL, followed_drawn = NULL WHERE id = ?',
      )
      .run(new Date().toISOString(), recipe, id);
  }

  /**
   * Where this chat's record has been read up to, or null if nothing has
   * followed it yet.
   *
   * `at` is always a line boundary. `drawn` is how many rows of the transcript
   * built FROM that byte are already on the screen — which is not always zero:
   * a record still being written ends in commands whose answers have not landed,
   * and those rows are read again with the answers rather than drawn twice. The
   * busiest chats are permanently in that state, so a mark that only ever named
   * a settled byte never got written for them at all (bw-uiyz.19).
   */
  followedTo(id: string): { at: number; drawn: number } | null {
    const r = this.db.prepare('SELECT followed_to, followed_drawn FROM session WHERE id = ?').get(id) as
      | { followed_to: number | null; followed_drawn: number | null }
      | undefined;
    if (!r || r.followed_to === null) return null;
    return { at: r.followed_to, drawn: r.followed_drawn ?? 0 };
  }

  /**
   * Drops the mark that says this chat's record has been read.
   *
   * Apart from the drawing, because they are different claims: a chat whose
   * follower stopped short of the end of its record has NOT been read, however
   * much of it is on the screen, and while that mark stands the reading is
   * refused before it starts (bw-jaoz.9).
   */
  forgetRead(id: string): void {
    this.db.prepare('UPDATE session SET imported_at = NULL, imported_recipe = NULL WHERE id = ?').run(id);
  }

  /** Says where the follower has read to, for the next open to carry on from. */
  rememberFollowed(id: string, at: number, drawn: number, recipe: number): void {
    // Read, in the same breath. A record being written always ends in commands
    // whose answers have not landed, so a chat another program is working in
    // never finished being read and was never marked — which is exactly why it
    // was read from its first byte on every click. The mark says where it
    // stopped AND how much of what stands there is drawn, so stopping there is
    // no longer losing anything, and the reading counts (bw-uiyz.19).
    this.db
      .prepare(
        `UPDATE session
            SET followed_to = ?, followed_drawn = ?,
                imported_at = COALESCE(imported_at, ?), imported_recipe = ?
          WHERE id = ?`,
      )
      .run(at, drawn, new Date().toISOString(), recipe, id);
  }

  /** Drops that mark: what is drawn and what the record holds no longer line up. */
  forgetFollowed(id: string): void {
    this.db.prepare('UPDATE session SET followed_to = NULL, followed_drawn = NULL WHERE id = ?').run(id);
  }

  /**
   * True once an agent has been attached to this chat here.
   *
   * The import never writes `session.started`; a live attach always does. So a
   * chat without one has a log that is entirely imported, and re-reading its
   * record can safely replace the lot. One WITH live turns in it cannot be
   * rewritten — its history is the only copy.
   */
  wasDrivenHere(id: string): boolean {
    const r = this.db
      .prepare("SELECT 1 AS yes FROM event WHERE session_id = ? AND type = 'session.started' LIMIT 1")
      .get(id) as { yes: number } | undefined;
    return !!r;
  }

  /**
   * Drops the searchable copy of an entirely-imported chat, before its record is
   * read in again under a newer reading.
   *
   * Only this copy: the event log is never deleted. Seq is handed out as one
   * past the highest in the log, so emptying it would start the replacement at
   * 1 while a browser mid-conversation is asking for everything after 300, and
   * that browser would be stranded on a blank chat until it reloaded. The log
   * instead gains a `transcript.reset` and then the new copy, which replays to
   * exactly what a browser that stayed connected saw (bw-1u1.27).
   */
  forgetImported(id: string): void {
    this.db.prepare('DELETE FROM message WHERE session_id = ?').run(id);
    this.forgetFollowed(id);
  }

  getSession(id: string): (SessionSummary & { origin: 'app' | 'terminal' }) | undefined {
    const r = this.db.prepare('SELECT * FROM session WHERE id = ?').get(id) as Record<string, string> | undefined;
    return r ? { ...rowToSummary(r), origin: r.origin === 'terminal' ? 'terminal' : 'app' } : undefined;
  }

  /**
   * Carries `origin` as well: where a conversation began does not change
   * because the app later took it over, and the restore list says so.
   *
   * Ordered by the clock the list is ordered by: when the person last spoke,
   * and when he never has, when anything last happened (bw-zhs9). The rows are
   * sorted again once they are built — over facts this query cannot see, like
   * who is working right now — and this is that same order arriving in it, so
   * the wire and the screen never disagree about which chats are the newest.
   */
  listSessions(projectId?: string): (SessionSummary & { origin: 'app' | 'terminal' })[] {
    const rows = projectId
      ? this.db
          .prepare(
            'SELECT * FROM session WHERE project_id = ? ORDER BY COALESCE(last_spoke_at, last_active_at) DESC',
          )
          .all(projectId)
      : this.db.prepare('SELECT * FROM session ORDER BY COALESCE(last_spoke_at, last_active_at) DESC').all();
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

  /**
   * Appends one canonical event, or returns false when another delivery of the
   * same provider event is already present.
   *
   * The uniqueness lives here rather than in a driver/import branch: live,
   * replay, snapshots and future providers all have to cross this method.
   */
  appendEvent(e: WbpEvent): boolean {
    const identity = e.providerEvent;
    const result = this.db
      .prepare(
        `INSERT INTO event
           (session_id, seq, at, type, json, provider, provider_thread_id, provider_event_id)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, provider, provider_thread_id, provider_event_id)
           WHERE provider_event_id IS NOT NULL
         DO NOTHING`,
      )
      .run(
        e.sessionId, e.seq, e.at, e.type, JSON.stringify(e),
        identity?.provider ?? null,
        identity?.threadId ?? null,
        identity?.eventId ?? null,
      );
    return result.changes === 1;
  }

  /** Reports what a canonical rebuild would remove without writing anything. */
  auditCanonicalProjection(sessionId: string): CanonicalProjectionPlan {
    if (!this.getSession(sessionId)) throw new Error(`no session ${sessionId}`);
    return planCanonicalProjection(this.eventsSince(sessionId, 0));
  }

  /**
   * Atomically switches the visible transcript to a deduplicated projection.
   *
   * Old native and Atelier rows remain untouched before `transcript.reset`.
   * The reset and replacement rows commit together, so readers see the old
   * projection or the complete new one, never a half-rebuilt transcript.
   */
  rebuildCanonicalProjection(sessionId: string): CanonicalProjectionPlan & { resetSeq: number } {
    if (!this.getSession(sessionId)) throw new Error(`no session ${sessionId}`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const plan = planCanonicalProjection(this.eventsSince(sessionId, 0));
      let seq = this.nextSeq(sessionId);
      const resetSeq = seq;
      const reset: WbpEvent = {
        type: 'transcript.reset', sessionId, seq: seq++, at: new Date().toISOString(),
      };
      const insert = this.db.prepare(
        `INSERT INTO event
           (session_id, seq, at, type, json, provider, provider_thread_id, provider_event_id)
         VALUES (?,?,?,?,?,NULL,NULL,NULL)`,
      );
      insert.run(sessionId, reset.seq, reset.at, reset.type, JSON.stringify(reset));

      const projected: WbpEvent[] = [];
      for (const source of plan.projectedEvents) {
        const copy = { ...source, sessionId, seq: seq++ } as WbpEvent;
        delete copy.providerEvent;
        insert.run(sessionId, copy.seq, copy.at, copy.type, JSON.stringify(copy));
        projected.push(copy);
      }

      // Search is a disposable projection too. Rebuild it inside the same
      // switch so search and transcript never disagree about duplicated text.
      this.db.prepare('DELETE FROM message WHERE session_id = ?').run(sessionId);
      const opened = new Map<string, { role: string; text: string; at: string }>();
      for (const event of projected) {
        if (event.type === 'message.started') {
          opened.set(event.messageId, { role: event.role, text: '', at: event.at });
        } else if (event.type === 'text.delta') {
          const message = opened.get(event.messageId);
          if (message) message.text += event.text;
        } else if (event.type === 'message.retracted') {
          opened.delete(event.messageId);
        }
      }
      const putMessage = this.db.prepare(
        'INSERT INTO message (session_id, message_id, role, text, at) VALUES (?,?,?,?,?)',
      );
      for (const [messageId, message] of opened) {
        putMessage.run(sessionId, messageId, message.role, message.text, message.at);
      }

      this.db.exec('COMMIT');
      return { ...plan, resetSeq };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * On boot nothing is running, whatever the last write claimed. A row saying
   * `streaming` after a restart would promise a process that does not exist.
   *
   * Every row that is not already asleep, with nothing held back. A build that
   * shipped for one day wrote `ended` onto chats the owner closed, and that
   * word is gone (bw-cnxh.10); the rows carrying it are healed here rather
   * than by a migration, because this already runs on every start and the
   * answer it gives them is the true one.
   */
  markAllDormant(): void {
    this.db.prepare("UPDATE session SET state = 'dormant' WHERE state != 'dormant'").run();
  }

  rememberBeadLink(sessionId: string, beadId: string, via: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO bead_link (session_id, bead_id, via, first_seen_at) VALUES (?,?,?,?)')
      .run(sessionId, beadId, via, new Date().toISOString());
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

  /**
   * Semantic rows already owned by this timeline.
   *
   * Import policy used to count messages only. A locally-driven chat whose
   * first turn contained commands or helper notifications therefore looked
   * empty and accepted a complete native replay underneath those rows.
   */
  timelineCount(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM event
          WHERE session_id = ?
            AND type IN (
              'message.started', 'tool.started', 'note', 'ask.permission',
              'notice', 'agent.started'
            )`,
      )
      .get(sessionId) as { n: number };
    return row.n;
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

  /** Removes the search copy of a prompt pulled back before an answer began. */
  retractMessage(sessionId: string, messageId: string): void {
    this.db.prepare('DELETE FROM message WHERE session_id = ? AND message_id = ?').run(sessionId, messageId);
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

  /**
   * Materialises complete transcript items once, so a page is selected in the
   * same units the reader sees instead of by raw events or conversational
   * turns. The event log remains the source of truth; this table is disposable.
   */
  private rebuildTranscriptItems(sessionId: string, newestSeq: number, resetSeq: number): void {
    const rows = this.db
      .prepare('SELECT json FROM event WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, resetSeq) as { json: string }[];
    const view = foldAll(rows.map((row) => boundedEvent(JSON.parse(row.json) as WbpEvent)));

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM transcript_item WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM transcript_agent WHERE session_id = ?').run(sessionId);
      const put = this.db.prepare(
        `INSERT INTO transcript_item
           (session_id, item_key, position, updated_seq, visible, json)
         VALUES (?,?,?,?,?,?)`,
      );
      view.items.forEach((item, index) => {
        put.run(
          sessionId,
          itemKey(item),
          index + 1,
          newestSeq,
          itemIsVisible(item) ? 1 : 0,
          JSON.stringify(item),
        );
      });
      const putAgent = this.db.prepare(
        `INSERT INTO transcript_agent (session_id, agent_id, tool_call_id, json)
         VALUES (?,?,?,?)`,
      );
      view.agents.forEach((agent) => {
        putAgent.run(sessionId, agent.id, agent.toolCallId, JSON.stringify(agent));
      });
      this.db.prepare(
        `INSERT INTO transcript_projection (session_id, projected_seq, reset_seq)
         VALUES (?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           projected_seq = excluded.projected_seq,
           reset_seq = excluded.reset_seq`,
      ).run(sessionId, newestSeq, resetSeq);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * The item rows one event can touch. Feeding just these rows and the compact
   * agent index through the canonical live reducer keeps historical and live
   * shapes identical without rereading the conversation. Creation events
   * intentionally start with no item; their ids are canonical and unique.
   */
  private eventItems(sessionId: string, event: WbpEvent, agents: SentAway[]): Array<{ position: number; item: TranscriptItem }> {
    let keys: string[] = [];
    let all = false;
    switch (event.type) {
      case 'image':
      case 'image.compare':
      case 'widget':
      case 'text.delta':
        keys = [`message:${event.messageId}`];
        break;
      case 'thinking.delta':
        keys = [`thinking:${event.messageId}`];
        break;
      case 'message.completed':
        keys = [`message:${event.messageId}`, `thinking:${event.messageId}`];
        break;
      case 'message.retracted':
        keys = [`message:${event.messageId}`];
        break;
      case 'tool.started':
      case 'tool.completed':
      case 'tool.progress':
      case 'diff':
        keys = [`tool:${event.toolCallId}`];
        break;
      case 'agent.finished': {
        const toolCallId = agents.find((agent) => agent.id === event.agentId)?.toolCallId;
        if (toolCallId) keys = [`tool:${toolCallId}`];
        break;
      }
      case 'ask.resolved':
        keys = [`ask:${event.askId}`];
        break;
      case 'question.resolved':
        keys = [`question:${event.requestId}`];
        break;
      case 'plan.proposed':
        return (this.db
          .prepare("SELECT position, json FROM transcript_item WHERE session_id = ? AND item_key LIKE 'plan:%' ORDER BY position")
          .all(sessionId) as { position: number; json: string }[])
          .map((row) => ({ position: row.position, item: JSON.parse(row.json) as TranscriptItem }));
      case 'plan.resolved':
        keys = [`plan:${event.proposalId}`];
        break;
      case 'transcript.reset':
        all = true;
        break;
      default:
        break;
    }
    if (all) {
      return (this.db
        .prepare('SELECT position, json FROM transcript_item WHERE session_id = ? ORDER BY position')
        .all(sessionId) as { position: number; json: string }[])
        .map((row) => ({ position: row.position, item: JSON.parse(row.json) as TranscriptItem }));
    }
    if (!keys.length) return [];
    const get = this.db.prepare('SELECT position, json FROM transcript_item WHERE session_id = ? AND item_key = ?');
    return keys.flatMap((key) => {
      const row = get.get(sessionId, key) as { position: number; json: string } | undefined;
      return row ? [{ position: row.position, item: JSON.parse(row.json) as TranscriptItem }] : [];
    }).sort((a, b) => a.position - b.position);
  }

  /** Advances an existing durable projection through only the unseen tail. */
  private catchUpTranscriptItems(
    sessionId: string,
    projectedSeq: number,
    newestSeq: number,
    resetSeq: number,
  ): void {
    const events = this.db
      .prepare('SELECT json FROM event WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, projectedSeq) as { json: string }[];
    if (!events.length) return;

    let agents = (this.db
      .prepare('SELECT json FROM transcript_agent WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as { json: string }[])
      .map((row) => JSON.parse(row.json) as SentAway);
    let nextPosition = Number((this.db
      .prepare('SELECT COALESCE(MAX(position), 0) AS position FROM transcript_item WHERE session_id = ?')
      .get(sessionId) as { position: number }).position) + 1;
    const removeItem = this.db.prepare('DELETE FROM transcript_item WHERE session_id = ? AND item_key = ?');
    const putItem = this.db.prepare(
      `INSERT INTO transcript_item (session_id, item_key, position, updated_seq, visible, json)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id, item_key) DO UPDATE SET
         updated_seq = excluded.updated_seq,
         visible = excluded.visible,
         json = excluded.json`,
    );
    const removeAgents = this.db.prepare('DELETE FROM transcript_agent WHERE session_id = ?');
    const putAgent = this.db.prepare(
      `INSERT INTO transcript_agent (session_id, agent_id, tool_call_id, json)
       VALUES (?,?,?,?)`,
    );

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of events) {
        const event = boundedEvent(JSON.parse(row.json) as WbpEvent);
        const selected = this.eventItems(sessionId, event, agents);
        const positions = new Map(selected.map(({ item, position }) => [itemKey(item), position]));
        const beforeKeys = new Set(selected.map(({ item }) => itemKey(item)));
        const view = reduce({ ...EMPTY, items: selected.map(({ item }) => item), agents }, event);
        const afterKeys = new Set(view.items.map(itemKey));

        for (const key of beforeKeys) if (!afterKeys.has(key)) removeItem.run(sessionId, key);
        for (const item of view.items) {
          const key = itemKey(item);
          let position = positions.get(key);
          if (position === undefined) position = nextPosition++;
          putItem.run(sessionId, key, position, event.seq, itemIsVisible(item) ? 1 : 0, JSON.stringify(item));
        }

        if (view.agents !== agents) {
          agents = view.agents;
          removeAgents.run(sessionId);
          for (const agent of agents) putAgent.run(sessionId, agent.id, agent.toolCallId, JSON.stringify(agent));
        }
      }
      this.db.prepare(
        'UPDATE transcript_projection SET projected_seq = ?, reset_seq = ? WHERE session_id = ?',
      ).run(newestSeq, resetSeq, sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private ensureTranscriptItems(sessionId: string): number {
    const newest = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM event WHERE session_id = ?')
      .get(sessionId) as { seq: number };
    const reset = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM event WHERE session_id = ? AND type = 'transcript.reset'")
      .get(sessionId) as { seq: number };
    const projected = this.db
      .prepare('SELECT projected_seq, reset_seq FROM transcript_projection WHERE session_id = ?')
      .get(sessionId) as { projected_seq: number; reset_seq: number } | undefined;
    if (!projected) {
      this.rebuildTranscriptItems(sessionId, newest.seq, reset.seq);
    } else if (projected.projected_seq !== newest.seq) {
      // A reset behind the recorded projection means the projection record is
      // corrupt or came from an incompatible build. Ordinary resets are in the
      // unseen tail and are handled incrementally by the canonical reducer.
      if (reset.seq < projected.reset_seq) this.rebuildTranscriptItems(sessionId, newest.seq, reset.seq);
      else this.catchUpTranscriptItems(sessionId, projected.projected_seq, newest.seq, reset.seq);
    } else if (projected.reset_seq !== reset.seq) {
      this.rebuildTranscriptItems(sessionId, newest.seq, reset.seq);
    }
    return newest.seq;
  }

  /** The newest fixed-size page of complete visible items, or the page before
   * an exclusive item cursor. Pages are always returned in reading order. */
  transcriptItems(sessionId: string, before: number | null, limit = 40): TranscriptItemPage {
    const newestSeq = this.ensureTranscriptItems(sessionId);
    const ceiling = before ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        `SELECT position, json FROM transcript_item
          WHERE session_id = ? AND visible = 1 AND position < ?
          ORDER BY position DESC LIMIT ?`,
      )
      .all(sessionId, ceiling, limit) as { position: number; json: string }[];
    rows.reverse();
    const cursor = rows[0]?.position ?? null;
    const older = cursor === null ? undefined : this.db
      .prepare(
        `SELECT 1 AS yes FROM transcript_item
          WHERE session_id = ? AND visible = 1 AND position < ? LIMIT 1`,
      )
      .get(sessionId, cursor) as { yes: number } | undefined;
    return {
      items: rows.map((row) => JSON.parse(row.json) as TranscriptItem),
      cursor: older ? cursor : null,
      hasOlder: !!older,
      newestSeq,
    };
  }

  /** Latest non-transcript facts needed for an honest first paint. */
  sessionFactsEvents(sessionId: string): WbpEvent[] {
    const types = ['session.started', 'session.state', 'session.menu', 'session.pinned', 'cost', 'context', 'todo', 'thinking.progress', 'error'];
    const read = this.db.prepare('SELECT json FROM event WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1');
    const latest = types
      .map((type) => read.get(sessionId, type) as { json: string } | undefined)
      .filter((row): row is { json: string } => !!row)
      .map((row) => JSON.parse(row.json) as WbpEvent)
      .sort((a, b) => a.seq - b.seq);
    // Sent-away work is not transcript history: it is the live/finished agent
    // panel. Keep every lifecycle edge, but only the newest moving progress row
    // per agent, so a long-running helper cannot make chat-open proportional to
    // the number of times it reported its clock.
    const agents = this.db
      .prepare(
        `SELECT json FROM (
           SELECT seq, json FROM event
            WHERE session_id = ? AND type IN ('agent.started','agent.finished','agent.identified','agent.relayed')
           UNION ALL
           SELECT seq, json FROM (
             SELECT seq, json,
                    ROW_NUMBER() OVER (PARTITION BY json_extract(json, '$.agentId') ORDER BY seq DESC) AS place
               FROM event WHERE session_id = ? AND type = 'agent.progress'
           ) WHERE place = 1
         ) ORDER BY seq`,
      )
      .all(sessionId, sessionId) as { json: string }[];
    return [...latest, ...agents.map((row) => JSON.parse(row.json) as WbpEvent)].sort((a, b) => a.seq - b.seq);
  }

  /** The large fields for one tool row, fetched only after its disclosure opens. */
  toolDetails(sessionId: string, toolCallId: string): {
    input: Record<string, unknown>;
    output: string | null;
    diff: { path: string; before: string; after: string } | null;
  } | null {
    const rows = this.db
      .prepare(
        `SELECT json FROM event
          WHERE session_id = ?
            AND type IN ('tool.started','tool.completed','diff')
            AND json_extract(json, '$.toolCallId') = ?
          ORDER BY seq`,
      )
      .all(sessionId, toolCallId) as { json: string }[];
    if (!rows.length) return null;
    let input: Record<string, unknown> = {};
    let output: string | null = null;
    let diff: { path: string; before: string; after: string } | null = null;
    for (const row of rows) {
      const event = JSON.parse(row.json) as WbpEvent;
      if (event.type === 'tool.started') input = event.input;
      else if (event.type === 'tool.completed') output = event.output;
      else if (event.type === 'diff') diff = { path: event.path, before: event.before, after: event.after };
    }
    return { input, output, diff };
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
    effort: (r.effort as string) ?? null,
    title: (r.title as string) ?? null,
    state: r.state as SessionSummary['state'],
    createdAt: r.created_at as string,
    lastActiveAt: r.last_active_at as string,
    lastSpokeAt: (r.last_spoke_at as string) ?? null,
  };
}
