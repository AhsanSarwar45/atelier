/**
 * The live half of the workbench: which sessions have a driver attached, and
 * fanning their events out to the event log and to every open browser.
 *
 * Every event is written to the log before it is broadcast, so a browser that
 * reconnects and replays sees exactly what a browser that stayed connected saw.
 */
import { getSessionInfo, getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

import type { Brand, ImagePayload, SessionState, SessionSummary, WbpEvent } from '../../src/workbench/protocol.ts';
import { DEFAULT_PERMISSION_MODE } from '../../src/workbench/protocol.ts';
import {
  cut,
  IMPORTED_MESSAGES,
  type PastEntry,
  pastTranscript,
  settledUpTo,
  toolCallsOf,
  trimInput,
  withoutMachineChatter,
} from '../../src/workbench/imported-history.ts';
import { ClaudeDriver, toolTitle } from './drivers/claude.ts';
import type { Driver, DriverEvent, PermissionAnswer } from './drivers/types.ts';
import { Linker } from './linker.ts';
import { knownSessions } from './registry.ts';
import { runningNow } from './running.ts';
import type { Store } from './store.ts';

type Subscriber = (e: WbpEvent) => void;

/**
 * Which reading of a past chat's record this build does.
 *
 * 1 was the words alone. 2 is the words and the commands, which is what the
 * manager asked for after photographing the difference (§6.3.2). Raise it
 * whenever the import would produce a different transcript from the same
 * record: every chat read in by a lower one is read again on its next open.
 */
const IMPORT_RECIPE = 2;

/**
 * How often a chat another program is driving is looked at again.
 *
 * The look is one stat of one file — `getSessionInfo` reads that session's
 * record and no other — and the record itself is only re-read when that stat
 * has moved. Under two seconds is fast enough that a reader watching over
 * somebody's shoulder does not feel it lag.
 */
const FOLLOW_BEAT_MS = 1_500;

export class Sessions {
  private drivers = new Map<string, Driver>();
  private linkers = new Map<string, Linker>();
  private subs = new Map<string, Set<Subscriber>>();
  /** Listeners on every session at once — the app's single global stream. */
  private watchers = new Set<Subscriber>();
  /** Listeners told when a session comes into existence, before it says anything. */
  private openings = new Set<(s: SessionSummary) => void>();
  /**
   * The agent's own words for what each session is doing. Held here rather than
   * in the store: it is true only while a driver is attached, and a screen
   * opened later would otherwise be told a session is "Answering" when nothing
   * has been running since the last restart.
   */
  private labels = new Map<string, string>();
  /**
   * Chats another program is driving, being drawn here as they go: session id
   * to the call that stops watching (bw-dmxj.6).
   */
  private followers = new Map<string, () => void>();
  // Declared, not a parameter property: Node's strip-only TypeScript mode
  // rejects `constructor(private store: Store)`.
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Starts a driver and returns as soon as the session row exists, not when the agent replies. */
  async start(params: {
    projectId: string;
    projectPath: string;
    brand: Brand;
    model?: string;
    permissionMode?: string;
    brief?: { beadId: string; text: string };
  }): Promise<SessionSummary> {
    if (params.brand !== 'claude') {
      throw new Error(`No driver for brand "${params.brand}" yet — see docs/agent-workbench.md §3.2`);
    }
    const now = new Date().toISOString();
    const summary: SessionSummary = {
      id: randomUUID(),
      brand: params.brand,
      externalId: null,
      projectId: params.projectId,
      projectPath: params.projectPath,
      cwd: params.projectPath,
      model: params.model ?? null,
      permissionMode: params.permissionMode ?? DEFAULT_PERMISSION_MODE,
      title: null,
      state: 'starting',
      createdAt: now,
      lastActiveAt: now,
    };
    this.store.createSession({ ...summary, origin: 'app' });
    this.openings.forEach((fn) => fn(summary));

    await this.attach(summary, params.model);

    // Started FROM a card: the owner said so by pressing the button there, so
    // the link is recorded now rather than waited for. The brief is the chat's
    // own first turn, which is why it appears in the transcript like any other.
    if (params.brief) {
      this.publish(summary.id, { type: 'link.bead', beadId: params.brief.beadId, via: 'brief' });
      await this.send(summary.id, params.brief.text);
    }
    return summary;
  }

  /**
   * Opens a chat for READING: it gets an id, its past is read into the log, and
   * no agent is started. The first message sent to it is what wakes it
   * (docs/designs/app-shell.md §1.9).
   *
   * Nothing here may stamp the session row's last-active time, or a chat would
   * jump to the top of the list for having been looked at.
   */
  async open(params: {
    sessionId?: string;
    externalId?: string;
    brand: Brand;
    projectId: string;
    projectPath: string;
  }): Promise<SessionSummary> {
    // By our id when the app ran it, and otherwise by the brand's own id: a
    // conversation begun in a terminal already has a row after the first click,
    // and looking it up only by our id made a second row — and a second imported
    // copy of the same history — on every click after that (bw-m8o.12).
    const existing =
      (params.sessionId ? this.store.getSession(params.sessionId) : undefined) ??
      (params.externalId ? this.store.sessionByExternalId(params.externalId) : undefined);
    // Already running: the transcript is live, so opening it is looking at it.
    if (existing && this.drivers.has(existing.id)) return existing;

    if (existing) {
      // Somebody else is typing in it. Its record is still being written, so
      // what this app drew the last time it looked is behind by however long
      // ago that was, and reading it again is the only way to be level with the
      // conversation the reader is being shown.
      const live = this.heldElsewhere(existing);
      const read = await this.importPast(existing, live);
      // What the row already says, in the transcript's own words: the log's last
      // state may be `streaming` from a session this process never inherited,
      // and the writing box reads that to decide whether to offer Stop.
      if (existing.state === 'dormant' || existing.state === 'ended') {
        this.publish(existing.id, { type: 'session.state', state: existing.state, label: 'Asleep' });
      }
      if (live) this.follow(existing, read);
      return { ...existing };
    }

    // A conversation begun in a terminal, seen for the first time. It keeps the
    // time the brand's own index gives it, so reading it does not reorder the
    // list.
    const seen = params.externalId
      ? (await knownSessions(params.projectPath)).find((k) => k.externalId === params.externalId)
      : undefined;
    const summary: SessionSummary = {
      id: randomUUID(),
      brand: params.brand,
      externalId: params.externalId ?? null,
      projectId: params.projectId,
      projectPath: params.projectPath,
      cwd: seen?.cwd ?? params.projectPath,
      model: null,
      permissionMode: DEFAULT_PERMISSION_MODE,
      title: seen?.name ?? null,
      state: 'dormant',
      createdAt: new Date().toISOString(),
      lastActiveAt: seen?.lastActiveAt ?? new Date().toISOString(),
    };
    this.store.createSession({ ...summary, origin: 'terminal' });
    this.openings.forEach((fn) => fn(summary));
    const live = this.heldElsewhere(summary);
    const read = await this.importPast(summary, live);
    this.publish(summary.id, { type: 'session.state', state: 'dormant', label: 'Asleep' });
    if (live) this.follow(summary, read);
    return summary;
  }

  /**
   * Brings a session back: the one the app ran, or one begun in a terminal.
   * Only ever called from a click, or from the first message sent to a chat that
   * was open for reading — nothing here runs on its own (decision 8).
   */
  async resume(params: {
    sessionId?: string;
    externalId?: string;
    brand: Brand;
    projectId: string;
    projectPath: string;
  }): Promise<SessionSummary> {
    const existing = params.sessionId ? this.store.getSession(params.sessionId) : undefined;
    if (existing && this.drivers.has(existing.id)) return existing;

    const now = new Date().toISOString();
    const summary: SessionSummary =
      existing ??
      {
        id: randomUUID(),
        brand: params.brand,
        externalId: params.externalId ?? null,
        projectId: params.projectId,
        projectPath: params.projectPath,
        cwd: params.projectPath,
        model: null,
        permissionMode: DEFAULT_PERMISSION_MODE,
        title: null,
        state: 'starting',
        createdAt: now,
        lastActiveAt: now,
      };
    if (!existing) this.store.createSession({ ...summary, origin: 'terminal' });
    this.openings.forEach((fn) => fn(summary));

    // A row the app already knows keeps whatever state it was left in — dormant,
    // after a restart — and no driver event says otherwise until the owner types
    // something. Saying so here is what makes the row stop offering itself.
    this.publish(summary.id, { type: 'session.state', state: 'starting', label: 'Coming back' });

    const resumeId = params.externalId ?? summary.externalId ?? undefined;
    // What was said before this app ever saw the chat, so opening it is not a
    // blank screen (docs/agent-workbench.md §6.3.2).
    await this.importPast({ ...summary, externalId: resumeId ?? null });
    await this.attach(summary, summary.model ?? undefined, resumeId);
    return { ...summary, state: 'starting' };
  }

  /**
   * Reads what was already said in a chat out of the agent kit's own record and
   * writes it into the event log as the events that would have carried it.
   *
   * Once per reading of the record: the log is the transcript (§4), so importing
   * twice under the same rules would say everything twice. The words AND the
   * commands become rows, and the calls are read a second time by the rules the
   * live watcher uses, for the cards and the reports they name — without that a
   * chat this app never watched can never show either
   * (docs/agent-workbench.md §6.3.2).
   *
   * When the reading itself changes, a chat read in by an older one is read
   * again and its old copy replaced, so nothing is said twice. Only a chat whose
   * whole log came from an import can be rewritten that way — one with live
   * turns in it is the only copy of those, so it keeps what it has. The
   * replacement is read in full BEFORE the old copy goes, because a record can
   * be moved, pruned or belong to a worktree that no longer exists, and the log
   * is then the only copy the app has (bw-1u1.26).
   */
  private async importPast(summary: SessionSummary, live = false): Promise<number | null> {
    if (!summary.externalId) return null;
    // Said plainly on the row, not inferred from the cards it happens to have
    // touched: a chat that touched none failed that test forever, so every click
    // read the whole conversation off the disk again and re-ran the card scan,
    // which forks the board's own tool per candidate (bw-m8o.14).
    const readBy = this.store.importedBy(summary.id);
    if (!live && readBy !== null && readBy >= IMPORT_RECIPE) return null;

    const drawnAlready = readBy !== null || this.store.messageCount(summary.id) > 0;
    // Read in by an older build, so it has words and no commands. Its live
    // turns, if it has any, cannot be re-made from the record.
    if (drawnAlready && this.store.wasDrivenHere(summary.id)) {
      this.store.markImported(summary.id, IMPORT_RECIPE);
      return null;
    }

    let messages: SessionMessage[];
    try {
      messages = await getSessionMessages(summary.externalId, { dir: summary.cwd });
    } catch {
      return null; // No record to read: the chat keeps whatever it already has.
    }
    // The words AND the commands, in one order: a past chat drawn as sentences
    // alone is the fault the manager photographed (§6.3.2).
    const all = pastTranscript(messages);
    // A record still being written ends in calls whose answers have not landed
    // yet; those are held back rather than drawn finished and empty. The number
    // this returns is the mark the follower carries on from, so the two use one
    // rule and no row is drawn twice or missed between them.
    const past = live ? all.slice(0, settledUpTo(all)) : all;
    // From here the record HAS been read, whatever it turned out to hold — an
    // empty one is still a read, and reading it again would find it empty again.
    this.store.markImported(summary.id, IMPORT_RECIPE);
    if (past.length === 0) return past.length;

    // Only now is the old copy thrown away: there is something to put in its
    // place (bw-1u1.26). A browser already drawing that copy is told to drop it
    // in the same breath, or it draws the replacement underneath (bw-1u1.27).
    if (drawnAlready) {
      this.store.forgetImported(summary.id);
      this.publish(summary.id, { type: 'transcript.reset' });
    }

    // What it did, read before what it said, so the chat's cards and reports are
    // already on the line by the time the first message is drawn.
    const links = new Linker(summary.id, summary.cwd, (e) => this.publish(summary.id, e));
    for (const m of messages) {
      for (const call of toolCallsOf(m.message)) links.observe(call.name, call.input);
    }

    const shown = past.slice(-IMPORTED_MESSAGES);
    if (past.length > shown.length) {
      this.publish(summary.id, {
        type: 'notice',
        text: `${past.length - shown.length} earlier messages and commands are in this chat and are not drawn here.`,
      });
    }
    for (const entry of shown) this.draw(summary.id, entry);
    return past.length;
  }

  /**
   * One row of a record, said in the events that would have carried it live —
   * so a command read off the disk and one watched as it ran open the same way
   * (docs/agent-workbench.md §8.2.4).
   */
  private draw(sessionId: string, entry: PastEntry): void {
    if (entry.kind === 'said') {
      const messageId = randomUUID();
      this.publish(sessionId, { type: 'message.started', messageId, role: entry.role });
      this.publish(sessionId, { type: 'text.delta', messageId, text: entry.text });
      this.publish(sessionId, { type: 'message.completed', messageId });
      return;
    }
    this.publish(sessionId, {
      type: 'tool.started',
      toolCallId: entry.id,
      name: entry.name,
      input: trimInput(entry.input),
      title: toolTitle(entry.name, entry.input),
      parentToolCallId: null,
    });
    this.publish(sessionId, {
      type: 'tool.completed',
      toolCallId: entry.id,
      ok: entry.ok,
      output: cut(entry.output),
    });
  }

  /**
   * Is a live process on this machine holding this conversation right now?
   *
   * Read fresh, not remembered: this answer decides once and for all whether
   * the chat being opened is followed, and a chat that started being worked in
   * a moment ago is missing from a two-second-old answer (running.ts).
   */
  private heldElsewhere(summary: SessionSummary): boolean {
    return summary.externalId !== null && runningNow(true).has(summary.externalId);
  }

  /**
   * Draws what a chat gains while another program is driving it.
   *
   * Opening such a chat used to be a photograph: whatever the record held at
   * the moment of the click, and then nothing, however long the reader sat
   * there watching an agent work somewhere else (bw-dmxj.6). There is no event
   * to subscribe to — the other program answers to its own terminal, not to us
   * — so this watches the record, which is the only thing the two halves share.
   *
   * A beat is one stat. The record is re-read only when that stat has moved,
   * and only entries past the mark are said, so a chat nothing is happening in
   * costs a stat and nothing else.
   *
   * `from` is where the import left off, or `null` when it did not read the
   * record at all — a chat with live turns of its own keeps them, and the first
   * beat then sets the mark without saying anything, so following starts from
   * now rather than repeating what is already on the screen.
   */
  private follow(summary: SessionSummary, from: number | null): void {
    const externalId = summary.externalId;
    if (externalId === null) return;
    if (this.followers.has(summary.id)) return;

    let mark = from;
    let stamp = '';
    let reading = false;
    // Its own, because the session has no driver and so no linker in the map:
    // the cards and reports a command names are found here or not at all.
    const links = new Linker(summary.id, summary.cwd, (e) => this.publish(summary.id, e));

    const draw = async (): Promise<void> => {
      let messages: SessionMessage[];
      try {
        messages = await getSessionMessages(externalId, { dir: summary.cwd });
      } catch {
        return; // Being written to this instant, or moved: try the next beat.
      }
      const past = pastTranscript(messages);
      const upto = settledUpTo(past);
      // The first look at a chat whose record was not imported: where it has
      // got to is the mark, and nothing before it is said again.
      if (mark === null) {
        mark = upto;
        return;
      }
      // Compaction rewrites the record shorter than it was. What is already
      // drawn stays drawn — it is the only copy of those turns — and the mark
      // moves to the new end rather than replaying it as if it were new.
      if (past.length < mark) {
        mark = upto;
        return;
      }
      const fresh = past.slice(mark, upto);
      if (fresh.length === 0) return;
      mark = upto;
      for (const entry of fresh) {
        if (entry.kind === 'call') links.observe(entry.name, entry.input);
        this.draw(summary.id, entry);
      }
    };

    const look = async (): Promise<void> => {
      if (reading) return;
      reading = true;
      try {
        const still = runningNow().has(externalId);
        let now = '';
        try {
          const info = await getSessionInfo(externalId, { dir: summary.cwd });
          if (info) now = `${info.lastModified}:${info.fileSize ?? 0}`;
        } catch {
          now = stamp; // Unreadable this beat; not a reason to re-read it all.
        }
        // Read on a change, and once more when the other program has gone: its
        // last words may have landed after the beat that saw it still there.
        if (now !== stamp || !still) {
          stamp = now;
          await draw();
        }
        if (!still) this.unfollow(summary.id);
      } finally {
        reading = false;
      }
    };

    const beat = setInterval(() => void look(), FOLLOW_BEAT_MS);
    // Watching a chat is not a reason for the sidecar to stay up.
    beat.unref?.();
    this.followers.set(summary.id, () => clearInterval(beat));
    void look();
  }

  /** Stops watching a chat's record: it has stopped, or this app has taken it over. */
  private unfollow(sessionId: string): void {
    this.followers.get(sessionId)?.();
    this.followers.delete(sessionId);
  }

  /** Starts the driver for a session row and wires its linker. */
  private async attach(summary: SessionSummary, model?: string, resume?: string): Promise<void> {
    // This app is driving it now, and the driver says everything the record
    // would: watching both would say each turn twice.
    this.unfollow(summary.id);
    const driver = new ClaudeDriver();
    this.drivers.set(summary.id, driver);
    this.linkers.set(
      summary.id,
      new Linker(summary.id, summary.cwd, (e) => this.publish(summary.id, e)),
    );
    await driver.start({
      cwd: summary.cwd,
      model,
      permissionMode: summary.permissionMode,
      resume,
      emit: (e) => this.publish(summary.id, e),
    });
    // What it is pinned to, said before the agent says anything: a session sends
    // no `init` until the first turn (docs/agent-workbench.md §7), and a chat
    // whose pickers read "Model" until he has typed is a chat that looks broken.
    this.publish(summary.id, {
      type: 'session.pinned',
      permissionMode: summary.permissionMode,
      model: model ?? summary.model ?? null,
    });
  }

  async send(sessionId: string, text: string, images: ImagePayload[] = []): Promise<void> {
    // Sending is what wakes a chat that was opened for reading. Nothing else
    // does, so a link into a sleeping conversation is a working one the moment
    // he types (docs/designs/app-shell.md §1.9).
    if (!this.drivers.has(sessionId)) {
      const row = this.store.getSession(sessionId);
      if (!row) throw new Error(`session ${sessionId} is not running`);
      this.publish(sessionId, { type: 'notice', text: 'Continuing this chat.' });
      await this.resume({
        sessionId,
        externalId: row.externalId ?? undefined,
        brand: row.brand,
        projectId: row.projectId,
        projectPath: row.projectPath,
      });
    }
    const driver = this.require(sessionId);
    // The user's own turn belongs in the transcript before the agent answers it.
    const messageId = randomUUID();
    this.publish(sessionId, { type: 'message.started', messageId, role: 'user' });
    for (const image of images) this.publish(sessionId, { type: 'image', messageId, image });
    this.publish(sessionId, { type: 'text.delta', messageId, text });
    this.publish(sessionId, { type: 'message.completed', messageId });

    const s = this.store.getSession(sessionId);
    if (s && !s.title) this.store.updateSession(sessionId, { title: text.slice(0, 80) });

    await driver.send({ text, images });
  }

  answer(sessionId: string, askId: string, optionId: string): void {
    this.require(sessionId).answer(askId, optionId as PermissionAnswer);
  }

  /**
   * Changes what the OPEN chat is pinned to, and remembers it: the mode is
   * re-pinned on every resume (§3.1), so a change made here has to outlive the
   * chat going to sleep.
   */
  async pin(sessionId: string, what: { mode?: string; model?: string }): Promise<void> {
    const driver = this.require(sessionId);
    if (what.mode !== undefined) {
      await driver.setMode(what.mode);
      this.store.updateSession(sessionId, { permissionMode: what.mode });
    }
    if (what.model !== undefined) {
      await driver.setModel(what.model);
      this.store.updateSession(sessionId, { model: what.model });
    }
    const now = this.store.getSession(sessionId);
    this.publish(sessionId, {
      type: 'session.pinned',
      permissionMode: now?.permissionMode ?? null,
      model: now?.model ?? null,
    });
  }

  async stop(sessionId: string): Promise<void> {
    await this.require(sessionId).interrupt();
  }

  private require(sessionId: string): Driver {
    const d = this.drivers.get(sessionId);
    if (!d) throw new Error(`session ${sessionId} is not running`);
    return d;
  }

  /** Stamps identity onto a driver event, logs it, then fans it out. */
  private publish(sessionId: string, e: DriverEvent): void {
    const full = {
      ...e,
      seq: this.store.nextSeq(sessionId),
      sessionId,
      at: new Date().toISOString(),
    } as WbpEvent;

    this.store.appendEvent(full);

    // The linker reads OUR vocabulary, not the brand's, so every driver feeds it.
    if (full.type === 'tool.started') {
      this.linkers.get(sessionId)?.observe(full.name, full.input);
    } else if (full.type === 'link.bead') {
      this.store.rememberBeadLink(sessionId, full.beadId, full.via);
    } else if (full.type === 'report.available') {
      this.store.rememberReportLink(sessionId, full.project, full.slug);
    } else if (full.type === 'session.pinned' && full.permissionMode !== null) {
      // The mode is re-pinned on every resume from what is stored (§3.1), so a
      // mode the tool changed by itself — approving a plan ends plan mode — has
      // to be written down here or the chat wakes up back in the old one
      // (bw-1u1.43).
      this.store.updateSession(sessionId, { permissionMode: full.permissionMode });
    }

    // What was said and what it cost, folded out of the log as it goes by, so
    // searching and totalling never re-read every event of every session.
    if (full.type === 'message.started') {
      this.store.openMessage(sessionId, full.messageId, full.role, full.at);
    } else if (full.type === 'text.delta') {
      this.store.growMessage(sessionId, full.messageId, full.text);
    } else if (full.type === 'cost') {
      const s = this.store.getSession(sessionId);
      this.store.rememberTurn({
        sessionId,
        projectId: s?.projectId ?? '',
        brand: s?.brand ?? 'claude',
        at: full.at,
        usd: full.cost.kind === 'usd' ? full.cost.usd : null,
        input: full.cost.kind === 'tokens' ? full.cost.input : null,
        output: full.cost.kind === 'tokens' ? full.cost.output : null,
        total: full.cost.kind === 'tokens' ? full.cost.total : null,
      });
    }

    if (full.type === 'session.state') {
      // Falling asleep, or being read while asleep, is not activity: the row
      // keeps its place in the list (docs/designs/app-shell.md §1.9).
      const asleep = full.state === 'dormant' || full.state === 'ended';
      this.store.updateSession(sessionId, { state: full.state as SessionState }, !asleep);
      this.labels.set(sessionId, full.label);
    } else if (full.type === 'session.started') {
      this.store.updateSession(sessionId, { externalId: full.externalId, model: full.model });
    }

    for (const sub of this.subs.get(sessionId) ?? []) sub(full);
    for (const sub of this.watchers) sub(full);
  }

  subscribe(sessionId: string, fn: Subscriber): () => void {
    if (!this.subs.has(sessionId)) this.subs.set(sessionId, new Set());
    this.subs.get(sessionId)!.add(fn);
    return () => this.subs.get(sessionId)?.delete(fn);
  }

  /**
   * Every session's events, for the one stream the whole app watches: the
   * waiting-on-you tray, the glance strip and the live dot on a board card all
   * read from it, so the browser holds one connection rather than one per
   * component (docs/agent-workbench.md §8.6).
   */
  watch(fn: Subscriber): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /**
   * A session exists from the moment it is created, not from its first word.
   * The card it was started from is linked before the agent has said anything,
   * so a screen that only learned of sessions from their events would never
   * hear about that link at all.
   */
  watchOpen(fn: (s: SessionSummary) => void): () => void {
    this.openings.add(fn);
    return () => this.openings.delete(fn);
  }

  /** What each attached session last said it was doing. */
  activity(sessionId: string): string {
    return this.labels.get(sessionId) ?? '';
  }

  /**
   * Matches with enough around them to read: the sentence the words fell in,
   * and which chat and project it was said in.
   */
  found(q: string): {
    sessionId: string;
    messageId: string;
    role: string;
    sentence: string;
    match: string;
    at: string;
    title: string | null;
    projectId: string;
  }[] {
    return this.store.search(q).map((m) => {
      const at = m.text.toLowerCase().indexOf(q.toLowerCase());
      // The sentence it fell in: back to the last full stop, on to the next.
      const from = Math.max(0, m.text.lastIndexOf('.', Math.max(0, at - 1)) + 1);
      const stop = m.text.indexOf('.', at + q.length);
      const s = this.store.getSession(m.sessionId);
      return {
        sessionId: m.sessionId,
        messageId: m.messageId,
        role: m.role,
        sentence: m.text.slice(from, stop < 0 ? Math.min(m.text.length, at + 240) : stop + 1).trim(),
        match: m.text.slice(at, at + q.length),
        at: m.at,
        title: s?.title ?? null,
        projectId: s?.projectId ?? '',
      };
    });
  }

  /**
   * The log as a reader should see it. The harness's own messages are dropped
   * here rather than at the point they were written, so a chat read in by an
   * older build stops showing them without being read again — reading it again
   * would say everything twice (§4).
   */
  replay(sessionId: string, since: number): WbpEvent[] {
    return withoutMachineChatter(this.store.eventsSince(sessionId, since));
  }
}
