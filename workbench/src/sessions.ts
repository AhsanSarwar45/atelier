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
  diffOf,
  howToRead,
  IMPORT_RECIPE,
  IMPORTED_MESSAGES,
  linkPast,
  type PastEntry,
  pastTranscript,
  settledUpTo,
  trimInput,
  withoutMachineChatter,
} from '../../src/workbench/imported-history.ts';
import { latest, type Recorded, windowNamed } from '../../src/workbench/context-window.ts';
import { ClaudeDriver, toolTitle } from './drivers/claude.ts';
import type { Driver, DriverEvent, PermissionAnswer } from './drivers/types.ts';
import { Linker } from './linker.ts';
import { findRecord, recordSize, RecordTail, type RecordLine } from './record-tail.ts';
import { knownSessions } from './registry.ts';
import { runningNow } from './running.ts';
import type { Store } from './store.ts';

type Subscriber = (e: WbpEvent) => void;

/**
 * How often a chat another program is driving is looked at again.
 *
 * The look is one stat of one file — `getSessionInfo` reads that session's
 * record and no other — and the record itself is only re-read when that stat
 * has moved. Under two seconds is fast enough that a reader watching over
 * somebody's shoulder does not feel it lag.
 */
const FOLLOW_BEAT_MS = 1_500;

/**
 * Where reading a chat's record got to, so the follower carries on from there
 * rather than reading the whole thing again.
 *
 * `at` is the byte the record stood at BEFORE it was read, and `through` the
 * last line that reading took in. The follower starts at the byte and throws
 * away everything up to and including that line, so a line written while the
 * read was going on is neither said twice nor lost — which either number on its
 * own would do, one of the two ways.
 *
 * `carry` is the messages whose rows were held back because their commands had
 * not answered yet; the follower reads them again with the answers attached and
 * draws only the `drawn` rows it has not already drawn.
 */
interface ReadSoFar {
  at: number | null;
  through: string | null;
  carry: RecordLine[];
  drawn: number;
}

/** The record was not read at all: the follower starts from the end of it. */
const NOTHING_READ: ReadSoFar = { at: null, through: null, carry: [], drawn: 0 };

/**
 * What the reader is told when the chat he typed into belongs to somebody else
 * for the moment. The screen says the same thing under the writing box, so the
 * refusal reads as the same rule twice rather than as a fault.
 */
export const HELD_ELSEWHERE = 'Another program is working in this chat. It draws here as it goes; you can type when it stops.';

/** The window these lines state, if any of them does; the last one wins. */
function windowIn(messages: readonly Recorded[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const named = windowNamed(messages[i]);
    if (named !== null) return named;
  }
  return null;
}

/**
 * What the follower needs to carry on from a whole-record read.
 *
 * `held` is how many rows that read kept back — trailing commands with no
 * answer yet. The messages those rows came from are handed on, together with
 * how many of their rows are already drawn, because the answers land in later
 * lines and the rows can only be finished by reading the two together.
 */
function readState(at: number | null, messages: readonly SessionMessage[], held: number): ReadSoFar {
  const through = messages.length > 0 ? (messages[messages.length - 1]?.uuid ?? null) : null;
  if (held <= 0) return { at, through, carry: [], drawn: 0 };
  // The shortest tail of the conversation that covers the held-back rows: a
  // message makes the same rows wherever it is read, so counting them off the
  // end is enough to find where they start.
  let take = 1;
  while (take < messages.length && pastTranscript(messages.slice(-take)).length < held) take += 1;
  const carry = messages.slice(-take);
  return { at, through, carry, drawn: pastTranscript(carry).length - held };
}

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
  /** The last fullness said for each chat, so an unchanged one is not said twice. */
  private fullness = new Map<string, number>();
  /**
   * The window each chat was last known to be measured against. The kit states
   * it once, in one line of the record; a later handful of lines names none, and
   * without this the figure would drop back to the ordinary window mid-chat
   * (bw-4wcd.15).
   */
  private windows = new Map<string, number>();
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
      this.follow(existing, read);
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
    this.follow(summary, read);
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

    // The door itself, not the sign on it. The screen refuses to type into a
    // conversation another program is working in, but it learns that from a
    // stream that can drop, and a dropped stream must not be all that stands
    // between a reader and a SECOND agent on somebody else's conversation
    // (bw-dmxj.12). Attaching is the only way a second one starts, and this is
    // the only door into attaching, so the answer is taken here, from the
    // directory, at the moment of the attempt. Nothing of ours is attached —
    // the line above returned — so whoever is holding it is not us.
    this.refuseIfHeld(params.externalId ?? existing?.externalId);

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
  private async importPast(summary: SessionSummary, live = false): Promise<ReadSoFar> {
    if (!summary.externalId) return NOTHING_READ;
    // Said plainly on the row, not inferred from the cards it happens to have
    // touched: a chat that touched none failed that test forever, so every click
    // read the whole conversation off the disk again and re-ran the card scan,
    // which forks the board's own tool per candidate (bw-m8o.14).
    const readBy = this.store.importedBy(summary.id);
    // Counted at most once, and only if the choice actually turns on it.
    let counted: number | null = null;
    const drawn = () => (counted ??= this.store.messageCount(summary.id));
    const choice = howToRead({
      readBy,
      live,
      drawn,
      // Read in by an older build, so it has words and no commands. Its live
      // turns, if it has any, cannot be re-made from the record.
      drivenHere: () => this.store.wasDrivenHere(summary.id),
    });
    if (choice === 'leave-it') return NOTHING_READ;
    if (choice === 'keep-what-it-has') {
      this.store.markImported(summary.id, IMPORT_RECIPE);
      return NOTHING_READ;
    }
    const drawnAlready = readBy !== null || drawn() > 0;

    // Where the record stands before a byte of it is read: what arrives while
    // the reading is going on is the follower's, and it can only know that if
    // it knows where the reading started (bw-uiyz.6).
    const at = recordSize(summary.externalId);
    let messages: SessionMessage[];
    try {
      messages = await getSessionMessages(summary.externalId, { dir: summary.cwd });
    } catch {
      return NOTHING_READ; // No record to read: the chat keeps what it has.
    }
    // Said the moment the record is read, because it is true of the record and
    // not of the drawing: a chat whose record holds nothing to draw still has a
    // size, and returning before saying it left the line blank (bw-4wcd.4).
    this.sayFullness(summary.id, messages);
    // The words AND the commands, in one order: a past chat drawn as sentences
    // alone is the fault the manager photographed (§6.3.2).
    const all = pastTranscript(messages);
    // A record still being written ends in calls whose answers have not landed
    // yet; those are held back rather than drawn finished and empty. The number
    // this returns is the mark the follower carries on from, so the two use one
    // rule and no row is drawn twice or missed between them.
    const upto = live ? settledUpTo(all) : all.length;
    const past = all.slice(0, upto);
    // From here the record HAS been read, whatever it turned out to hold — an
    // empty one is still a read, and reading it again would find it empty again.
    //
    // Unless a tail was held back. That tail is drawn by the follower and by
    // nothing else, so the moment the reader looks away it is nobody's: the
    // follower is torn down, and a chat already marked read is never read again,
    // so what the other program was mid-way through when he left is dropped for
    // good. A partial read is therefore not a read (bw-dmxj.14).
    if (upto === all.length) this.store.markImported(summary.id, IMPORT_RECIPE);
    const read = readState(at, messages, all.length - upto);
    if (past.length === 0) return read;

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
    linkPast(messages, (name, input) => links.observe(name, input));

    const shown = past.slice(-IMPORTED_MESSAGES);
    if (past.length > shown.length) {
      this.publish(summary.id, {
        type: 'notice',
        // The chat's own memory, drawn as one: it is the same thing to a reader
        // as the conversation folding itself up (bw-jkh2.5).
        family: 'memory',
        text: `${past.length - shown.length} earlier messages and commands are in this chat and are not drawn here.`,
      });
    }
    for (const entry of shown) this.draw(summary.id, entry);
    return read;
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
    // A change is read off the same arguments the live watcher reads it off, so
    // an edit in an imported chat is drawn as a change rather than as the new
    // text alone — which is what the manager was looking at when he said there
    // was no diff (bw-4wcd.1).
    const change = diffOf(entry.name, entry.input);
    if (change) this.publish(sessionId, { type: 'diff', toolCallId: entry.id, ...change });
    this.publish(sessionId, {
      type: 'tool.completed',
      toolCallId: entry.id,
      ok: entry.ok,
      output: cut(entry.output),
    });
  }

  /**
   * How full that conversation stands, taken from its own record.
   *
   * A chat begun in a terminal has no driver here to say it, and it is exactly
   * the chat whose reader most needs to know — his own long-running jobs are
   * the ones that fill up and get compacted (bw-4wcd.4).
   */
  private sayFullness(sessionId: string, messages: readonly Recorded[]): void {
    const now = latest(messages);
    if (!now) return;
    // The window is stated once, in one line of the record, and a handful of
    // newly arrived lines names none — so it is remembered rather than worked
    // out again from what happens to be in hand (bw-4wcd.15).
    let window = now.window;
    const named = windowIn(messages);
    if (named !== null) this.windows.set(sessionId, named);
    else window = this.windows.get(sessionId) ?? window;
    // Only when it has moved: this is read off the disk every few seconds while
    // anyone is watching, and the log IS the transcript — saying the same
    // figure again would grow the record without telling the reader anything.
    if (this.fullness.get(sessionId) === now.used) return;
    this.fullness.set(sessionId, now.used);
    this.publish(sessionId, { type: 'context', used: now.used, window });
  }

  /**
   * Is a live process on this machine holding this conversation right now?
   *
   * Read fresh, not remembered: this answer decides once and for all whether
   * the chat being opened is followed, and a chat that started being worked in
   * a moment ago is missing from a two-second-old answer (running.ts).
   */
  /**
   * Refuses to put a driver of ours on a conversation a live process is already
   * holding. Read from the directory at the moment of the attempt, because the
   * screen's own copy of this answer rides a stream that can drop, and the lock
   * may not be only as good as that stream (bw-dmxj.12).
   */
  private refuseIfHeld(conversation: string | null | undefined): void {
    if (conversation && runningNow(true).has(conversation)) throw new Error(HELD_ELSEWHERE);
  }

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
   * costs a stat and nothing else. Every chat being read here that this app is
   * not driving is watched, whether or not a terminal is holding it at the
   * moment it is opened: the manager opens a conversation and types into it in
   * a terminal afterwards, and a rule that decided once at the click left that
   * chat frozen (bw-4wcd.20).
   *
   * A beat is one stat, and a record that moved is read from the byte the last
   * look stopped at — never from the start. Reading the whole of it and taking
   * it apart again cost 475ms on the manager's longest conversation, every
   * 1.5s, on the one thread this sidecar answers every other request from
   * (bw-uiyz.6).
   *
   * `read` is where the import left off. Its `at` is null when the record was
   * not read at all — a chat with live turns of its own keeps them — and
   * following then starts from the end of what is there now, so nothing already
   * on the screen is said again.
   */
  private follow(summary: SessionSummary, read: ReadSoFar): void {
    const externalId = summary.externalId;
    if (externalId === null) return;
    if (this.followers.has(summary.id) || this.drivers.has(summary.id)) return;
    const path = findRecord(externalId);
    if (path === null) return; // No record on this machine to follow.

    const tail = new RecordTail(path);
    // Set before the first beat, so a record that grows in between is read from
    // here and not from where it has got to by then.
    if (read.at === null) void tail.toEnd();
    else tail.seek(read.at);
    // Lines the import already took in, thrown away by name the first time they
    // come round again.
    let through = read.at === null ? null : read.through;
    let carry = read.carry;
    let drawn = read.drawn;
    let reading = false;
    // Its own, because the session has no driver and so no linker in the map:
    // the cards and reports a command names are found here or not at all.
    const links = new Linker(summary.id, summary.cwd, (e) => this.publish(summary.id, e));

    const draw = async (): Promise<void> => {
      const grown = await tail.grown();
      // Compaction rewrites the record shorter than it was. What is already
      // drawn stays drawn — it is the only copy of those turns — and reading
      // carries on from the new end rather than replaying it as if it were new.
      if (grown.rewritten) {
        carry = [];
        drawn = 0;
        through = null;
        await tail.toEnd();
        return;
      }
      let fresh = grown.fresh;
      if (through !== null) {
        const already = fresh.findIndex((line) => line.uuid === through);
        if (already !== -1) fresh = fresh.slice(already + 1);
        through = null;
      }
      if (fresh.length === 0) return;
      // How full it stands: the figure is the reader's only warning that a job
      // he is watching is about to be compacted (bw-4wcd.4).
      this.sayFullness(summary.id, fresh);
      // The held-back rows are worked out again WITH the lines that answer
      // them, which is the only way a command drawn empty last beat comes out
      // finished this one.
      const all = [...carry, ...fresh];
      const entries = pastTranscript(all);
      const upto = settledUpTo(entries);
      const said = entries.slice(drawn, upto);
      if (upto === entries.length) {
        carry = [];
        drawn = 0;
      } else {
        carry = all;
        drawn = upto;
      }
      for (const entry of said) {
        if (entry.kind === 'call') links.observe(entry.name, entry.input);
        this.draw(summary.id, entry);
      }
    };

    const look = async (): Promise<void> => {
      if (reading) return;
      reading = true;
      try {
        // The stat inside the read alone says whether there is anything new,
        // whoever wrote it and whether or not that program is still there.
        // Stopping the moment the terminal exited lost every later turn: the
        // manager answers a prompt, walks away, and comes back to a chat that
        // stopped growing at the first answer (bw-4wcd.20).
        await draw();
      } catch {
        // Being written to this instant, or moved: try the next beat.
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
      // Before the notice below, not after it: that notice is the chat waking
      // up, and a chat that is somebody else's does not wake (bw-dmxj.12).
      this.refuseIfHeld(row.externalId);
      // An agent being started, which is what background says (bw-jkh2.5).
      this.publish(sessionId, { type: 'notice', family: 'background', text: 'Continuing this chat.' });
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
    // He spoke. This is the ONLY place the second clock moves for a chat this
    // app drives — the whole point of it is that nothing the agent then does
    // moves it again (bw-zhs9). A chat started from a card comes through here
    // too: its brief is its first turn, sent like any other.
    this.store.markSpoke(sessionId);

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

  /**
   * The account's plan allowance, from whichever live session will answer.
   *
   * The figure is the account's, so any running chat's channel is as good as
   * any other's and the first one that answers wins. Null when nothing is
   * running or nothing running can say — the caller then asks the kit itself
   * (plan-usage.ts, bw-malh).
   */
  async planUsage(): Promise<unknown | null> {
    for (const driver of this.drivers.values()) {
      if (!driver.usage) continue;
      try {
        const got = await driver.usage();
        if (got) return got;
      } catch {
        // A session dying mid-question is not this reader's problem; the next
        // one, or the kit itself, answers.
      }
    }
    return null;
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
    return () => {
      const subs = this.subs.get(sessionId);
      subs?.delete(fn);
      // Watched only while somebody is looking at it: a chat whose last reader
      // has gone is caught up the next time it is opened, and the disk is left
      // alone until then (bw-4wcd.20).
      if (!subs || subs.size === 0) this.unfollow(sessionId);
    };
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
