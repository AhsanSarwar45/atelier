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
import { BRAND_DEFAULT_MODEL, DEFAULT_PERMISSION_MODE } from '../../src/workbench/protocol.ts';
import {
  carryOnAt,
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
import { HOLDER_WORD } from '../../src/workbench/chat-state.ts';
import { latest, type Recorded, windowNamed } from '../../src/workbench/context-window.ts';
import { NOTHING, type Split, type TaskSpend, taskSpend } from '../../src/workbench/token-picture.ts';
import { NOT_OURS_TO_ASK, readWindow, type TokenPicture } from '../../src/workbench/window-now.ts';
import { createDriver, defaultPermissionMode } from './drivers/index.ts';
import { codexMenu, codexThreadSettings, codexThreadUsageFromRollout, readCodexThread, readCodexThreadUsage, replayCodexThread } from './drivers/codex.ts';
import { toolTitle } from '../../src/workbench/said-what-it-ran.ts';
import type { Driver, DriverEvent, PermissionAnswer } from './drivers/types.ts';
import { Linker } from './linker.ts';
import { type HelperPast, helperNamed, helpersNow, helpersOf } from './helper-records.ts';
import { readOwnerSettings } from './owner-settings.ts';
import { spokenAsEvents } from './reading-back.ts';
import {
  allLines,
  findRecord,
  linePlace,
  recordSize,
  RecordTail,
  runningIn,
  saysWhatItRuns,
  type RecordLine,
} from './record-tail.ts';
import { knownSessions, runningCodexThreads } from './registry.ts';
import { runningNow } from './running.ts';
import type { Store } from './store.ts';

type Subscriber = (e: WbpEvent) => void;

/**
 * How long the read-ahead waits before looking again at whether the reader is
 * done with the thread, and between two chats when he is.
 */
const READ_AHEAD_PAUSE_MS = 250;

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
 * How often a row drawn as running is told how long it has been running.
 *
 * Slower than the beat that reads the record, because this one WRITES: every
 * line published is a line in the chat's own log for good (§8.2.2).
 */
const PROGRESS_BEAT_MS = 10_000;

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
 *
 * Which is why the first half is not typed here: it is the screen's own
 * sentence, imported. Written out separately it had already drifted — this said
 * the holder was "working in" the chat, and holding is not working; a terminal
 * left at a prompt holds one all night (bw-96is.13). "When they let go", for
 * the same reason: a holder that has merely stopped working still has it.
 */
export const HELD_ELSEWHERE = `${HOLDER_WORD.program}. It draws here as it goes; you can type when they let go of it.`;

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

/**
 * The same state, saying where the held-back lines BEGIN instead of holding
 * them.
 *
 * A whole-record read stops at a byte that is already past those lines, so a
 * follower handed them in a list has no byte for them and cannot say where it
 * stands — and a chat being written never settles, so it never got to say it at
 * all. Every click on the chats the manager watches read the whole record
 * again. Handed their byte instead, the follower reads those same lines back
 * off the record itself, skips the rows already drawn, and has a byte to mark
 * from its very first beat (bw-uiyz.19).
 *
 * The lines stay in hand if the record cannot be searched: correct either way,
 * only slower next time.
 */
async function carryByByte(read: ReadSoFar, sessionId: string | null): Promise<ReadSoFar> {
  if (read.carry.length === 0 || sessionId === null) return read;
  const head = read.carry[0]?.uuid;
  if (head === undefined) return read;
  const place = await linePlace(sessionId, head);
  if (place === null) return read;
  return { at: place.begins, through: null, carry: [], drawn: read.drawn };
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
  /** The last spend said for each chat, on the same terms as the fullness above. */
  private spend = new Map<string, number>();
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
    const now = new Date().toISOString();
    // What HE has already said a chat opens on, rather than what this app used
    // to invent: the mode and the model out of his own settings, and the app's
    // fallback only where his settings say nothing (bw-7ks.23, owner-settings.ts).
    const owner = params.brand === 'claude'
      ? readOwnerSettings(params.projectPath)
      : { model: null, permissionMode: null };
    const summary: SessionSummary = {
      id: randomUUID(),
      brand: params.brand,
      externalId: null,
      projectId: params.projectId,
      projectPath: params.projectPath,
      cwd: params.projectPath,
      model: params.model ?? owner.model ?? null,
      permissionMode: params.permissionMode ?? owner.permissionMode ?? defaultPermissionMode(params.brand),
      title: null,
      state: 'starting',
      createdAt: now,
      lastActiveAt: now,
    };
    this.store.createSession({ ...summary, origin: 'app' });
    this.openings.forEach((fn) => fn(summary));

    await this.attach(summary, summary.model ?? undefined);

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
      // Nothing of ours is driving this chat — the branch above returned if
      // one were — so a stored state that means an agent owes an answer is a
      // leftover from a process that has since gone. Such a chat drew "Coming
      // back" for as long as the app ran, with no event on its way to correct
      // it, because this only ever spoke for the two states it was already
      // sure of (bw-m8o.17). It says what is true instead, and writes it down,
      // so the list says the same thing without the chat being opened.
      const truth: SessionState = existing.state === 'ended' ? 'ended' : 'dormant';
      if (truth !== existing.state) this.store.updateSession(existing.id, { state: truth }, false);
      this.publish(existing.id, {
        type: 'session.state',
        state: truth,
        label: truth === 'ended' ? 'Ended' : 'Asleep',
      });
      this.follow(existing, read);
      return { ...existing, state: truth };
    }

    // A conversation begun in a terminal, seen for the first time. It keeps the
    // time the brand's own index gives it, so reading it does not reorder the
    // list.
    const seen = params.externalId
      ? (await knownSessions(params.projectPath)).find((k) => k.brand === params.brand && k.externalId === params.externalId)
      : undefined;
    const summary: SessionSummary = {
      id: randomUUID(),
      brand: params.brand,
      externalId: params.externalId ?? null,
      projectId: params.projectId,
      projectPath: params.projectPath,
      cwd: seen?.cwd ?? params.projectPath,
      model: null,
      // A chat begun in a terminal runs in whatever mode that terminal is in,
      // and it says so itself the moment this app takes it over. Until it does,
      // his own settings are the better guess than a literal (bw-7ks.23).
      permissionMode: params.brand === 'claude'
        ? readOwnerSettings(params.projectPath).permissionMode ?? DEFAULT_PERMISSION_MODE
        : defaultPermissionMode(params.brand),
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
        // Same as a chat this app started: his settings answer it, not a
        // literal in here (bw-7ks.23). A row the app already knows keeps the
        // mode it was left in — that is the `existing` branch above.
        permissionMode: params.brand === 'claude'
          ? readOwnerSettings(params.projectPath).permissionMode ?? DEFAULT_PERMISSION_MODE
          : defaultPermissionMode(params.brand),
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
    // What it was running, before anything is asked of the kit. Handing it no
    // model is how the kit is told to work one out, and it works it out of the
    // owner's settings file — so a chat begun in a terminal, or one he never
    // picked a model in, took on whatever was last picked anywhere else and
    // then froze there without saying so (bw-7ojj). Its own record already
    // knows, so it is asked first and the answer is kept.
    const on = summary.model ?? (await this.modelItWasOn(resumeId));
    if (on && on !== summary.model) this.store.updateSession(summary.id, { model: on });
    // What was said before this app ever saw the chat, so opening it is not a
    // blank screen (docs/agent-workbench.md §6.3.2).
    await this.importPast({ ...summary, externalId: resumeId ?? null });
    await this.attach({ ...summary, model: on }, on ?? undefined, resumeId);
    return { ...summary, model: on, state: 'starting' };
  }

  /**
   * The model a chat was last answering on, out of its own record.
   *
   * `null` for a chat with no record and for one that has never answered — a
   * conversation nobody has said anything in yet was on nothing, and the kit
   * resolving that one from his settings is the right answer rather than the
   * fault above.
   */
  private async modelItWasOn(externalId: string | undefined): Promise<string | null> {
    if (!externalId) return null;
    const path = findRecord(externalId);
    if (!path) return null;
    // Never fatal: a record being written this instant, or one moved out from
    // under us, costs the chat its remembered model and nothing more.
    return runningIn(path)
      .then((r) => r.model)
      .catch(() => null);
  }

  /**
   * Every chat whose record this app has never read, read once behind the
   * reader's back.
   *
   * Reading a chat's record is what the FIRST click on it waits for — up to
   * 2.4s on the manager's longest, against a quarter of a second for every
   * click after — and 146 of the 171 chats on this machine had never been
   * read. Nobody is waiting here, so they are read newest first, which is the
   * order the list is in and the order he clicks in.
   *
   * One at a time with a breath between: this is the one thread the sidecar
   * answers every other request from, so the loop must never hold it for two
   * records running. A chat somebody is driving is left alone — its driver is
   * writing the log this would be reading (bw-uiyz.12).
   */
  /** The reading of a record now under way, so the next one waits for it. */
  private importing: Promise<void> = Promise.resolve();

  async readAhead(busy: () => boolean = () => false): Promise<number> {
    let read = 0;
    for (const summary of this.store.listSessions()) {
      if (this.drivers.has(summary.id)) continue;
      // Read the way a click would read it. A chat another program is driving
      // read as if it were quiet leaves no byte to carry on from, so the
      // reader's first click on it read the whole record a second time — 876ms
      // on his longest, which is the one case the timing run still failed
      // (bw-uiyz.20).
      const live = this.heldElsewhere(summary);
      const readBy = this.store.importedBy(summary.id);
      const already = readBy !== null && readBy >= IMPORT_RECIPE;
      if (already && !(live && this.store.followedTo(summary.id) === null)) continue;
      // Nothing here is worth a reader waiting behind. Reading all of them
      // takes the better part of a minute of this thread, and a click that
      // arrived in the middle of that waited 7.8s for it (bw-uiyz.12).
      while (busy()) await new Promise((wake) => setTimeout(wake, READ_AHEAD_PAUSE_MS));
      try {
        await this.importPast(summary, live);
        read += 1;
      } catch {
        // A record that has been moved, pruned, or never existed. The click
        // itself handles that the same way; it is not worth stopping for.
      }
      await new Promise((wake) => setTimeout(wake, READ_AHEAD_PAUSE_MS));
    }
    return read;
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
    // ONE reading of a record at a time in the whole process, whoever asked
    // for it. Nothing ever read two at once until the read-ahead could be in
    // the middle of one chat while the reader clicked another, and a store
    // written by two readings at once came back malformed (bw-uiyz.12). A
    // click that lands mid-chat waits out that one chat and no more; a click
    // on the chat being read finds it already read and returns at once.
    const queued = this.importing.then(() => this.importOnce(summary, live));
    this.importing = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  /**
   * Where a live chat's reading picks up, if it can pick up at all.
   *
   * Three things have to hold: this build's own reading is what drew it, the
   * follower reached a settled byte before the reader last looked away, and the
   * record is still at least that long — one shorter than that has been
   * compacted under us and the byte means nothing in the new one (bw-uiyz.19).
   */
  private carryOnFrom(summary: SessionSummary, readBy: number | null): ReadSoFar | null {
    const followedTo = this.store.followedTo(summary.id);
    // Asked for only when there is a byte to weigh it against: finding the
    // record is a listing of the projects directory.
    const recordNow =
      followedTo === null || summary.externalId === null ? null : recordSize(summary.externalId);
    const on = carryOnAt({ readBy, followedTo, recordNow });
    // `carry` stays empty: the lines it would hold are still in the record at
    // that byte, and the follower reads them again from there. `drawn` is what
    // keeps them from being drawn a second time.
    return on === null ? null : { at: on.at, through: null, carry: [], drawn: on.drawn };
  }

  /** One reading of a chat's record, with nothing else reading the same one. */
  private async importOnce(summary: SessionSummary, live = false): Promise<ReadSoFar> {
    if (!summary.externalId) return NOTHING_READ;
    if (summary.brand === 'codex') {
      try {
        const [thread, usage, menu] = await Promise.all([
          readCodexThread(summary.externalId, summary.cwd),
          readCodexThreadUsage(summary.externalId, summary.cwd).catch(() => null),
          codexMenu(summary.cwd).catch(() => null),
        ]);
        if (menu) {
          const { skillPaths: _skillPaths, ...shown } = menu;
          this.publish(summary.id, { type: 'session.menu', ...shown } as DriverEvent);
        }
        const settings = codexThreadSettings(thread);
        this.publish(summary.id, { type: 'session.pinned', model: settings.model, permissionMode: settings.permissionMode });
        const importedAt = this.store.importedAt(summary.id);
        const changedAt = Number(thread.updatedAt) * 1000;
        if (!importedAt || !Number.isFinite(changedAt) || changedAt > Date.parse(importedAt)) {
          if (this.store.importedBy(summary.id) !== null) {
            this.publish(summary.id, { type: 'transcript.reset' });
            this.store.forgetImported(summary.id);
          }
          replayCodexThread(thread, (event) => this.publish(summary.id, event));
          this.store.markImported(summary.id, IMPORT_RECIPE);
        }
        const recordedUsage = codexThreadUsageFromRollout(thread);
        const spend = usage ?? recordedUsage;
        if (spend) this.publish(summary.id, { type: 'cost', cost: { kind: 'tokens', input: spend.input, output: spend.output, total: spend.total } });
        if (recordedUsage?.contextWindow) this.publish(summary.id, { type: 'context', used: recordedUsage.contextUsed, window: recordedUsage.contextWindow });
      } catch {
        // A missing or concurrently-written thread leaves the existing log alone.
      }
      return NOTHING_READ;
    }
    // Said plainly on the row, not inferred from the cards it happens to have
    // touched: a chat that touched none failed that test forever, so every click
    // read the whole conversation off the disk again and re-ran the card scan,
    // which forks the board's own tool per candidate (bw-m8o.14).
    // A mark left short of the end of the record says the record holds lines
    // nobody has drawn: the follower stopped mid-turn. While the chat is being
    // driven the follower picks them up; once it is not, nothing ever will —
    // the follower was torn down when the reader looked away, and a chat
    // written down as read is never read again. So the record is read from the
    // top and every mark on it dropped, the reading mark included: left
    // standing, it refuses the reading before it starts and the reader is
    // handed the same stale copy on every open for the life of the chat
    // (bw-dmxj.14, bw-jaoz.9).
    //
    // The record's own length is what says it. How many of the mark's rows are
    // drawn does not: a follower holding a command back until its answer lands
    // marks the byte that command BEGINS at with none of it drawn, and that is
    // the state every chat the manager watches is permanently in.
    let stale = false;
    if (!live) {
      const held = this.store.followedTo(summary.id);
      const reaches = held === null ? null : recordSize(summary.externalId);
      if (held !== null && reaches !== null && reaches !== held.at) {
        // Whether the reader has a copy of this chat in front of him, asked
        // before it is thrown away: he is owed the word to drop it, or the
        // replacement is drawn underneath what it replaces.
        stale = this.store.importedBy(summary.id) !== null || this.store.messageCount(summary.id) > 0;
        this.store.forgetImported(summary.id);
        this.store.forgetRead(summary.id);
      }
    }
    const readBy = this.store.importedBy(summary.id);
    // A chat another program is driving is never finished being read, so it was
    // read from its first byte again on EVERY click: the whole record parsed,
    // the drawing thrown away and published afresh. That is the several seconds
    // the manager waits on exactly the chats he watches most. The follower
    // stopped at a byte last time; carrying on from it draws only what has
    // arrived since, and what is already drawn stays on the screen (bw-uiyz.19).
    if (live) {
      const on = this.carryOnFrom(summary, readBy);
      if (on) return on;
    }
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
    const drawnAlready = stale || readBy !== null || drawn() > 0;

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
    // The byte this reading ends at, left on the chat once the rest of the
    // reading has been done — never before, because dropping the old drawing
    // below clears every mark the chat carries, and a mark written above it was
    // wiped a dozen lines later (bw-uiyz.20).
    let settledAfter: number | null = null;
    // From here the record HAS been read, whatever it turned out to hold — an
    // empty one is still a read, and reading it again would find it empty again.
    //
    // Unless a tail was held back. That tail is drawn by the follower and by
    // nothing else, so the moment the reader looks away it is nobody's: the
    // follower is torn down, and a chat already marked read is never read again,
    // so what the other program was mid-way through when he left is dropped for
    // good. A partial read is therefore not a read (bw-dmxj.14).
    if (upto === all.length) {
      this.store.markImported(summary.id, IMPORT_RECIPE);
      // And the byte after the last line this reading took in, so the NEXT open
      // carries on from there rather than reading the record again
      // (bw-uiyz.19). Asked of the record by name rather than taken from its
      // size, because an active chat is written to WHILE it is being read and
      // those lines were read too: the size is a byte this reading is already
      // past, and a mark left there would say the lines between twice
      // (bw-uiyz.20).
      const ended = messages[messages.length - 1]?.uuid;
      const last = ended === undefined ? null : await linePlace(summary.externalId, ended);
      settledAfter = last?.after ?? null;
    }
    const read = await carryByByte(readState(at, messages, all.length - upto), summary.externalId);
    /**
     * Where this reading got to, written on the chat so the next open carries
     * on from it instead of reading the record again (bw-uiyz.19).
     *
     * Two ways to know it, and a chat being written is the reason for both: the
     * byte after the last line taken in when the reading settled, and the byte
     * the held-back lines BEGIN at when it did not. Kept whether or not anyone
     * follows this chat, because a chat read AHEAD of the reader has no
     * follower and its reading would otherwise count for nothing (bw-uiyz.20).
     */
    const leaveMark = (): void => {
      if (read.through === null && read.at !== null) {
        this.store.rememberFollowed(summary.id, read.at, read.drawn, IMPORT_RECIPE);
      } else if (settledAfter !== null) {
        this.store.rememberFollowed(summary.id, settledAfter, 0, IMPORT_RECIPE);
      }
    };
    if (past.length === 0) {
      leaveMark();
      return read;
    }

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

    /**
     * Every agent this chat sent off, from its own record beside the chat's
     * (helper-records.ts). Its calls are read for cards and reports exactly as
     * the chat's own are: work a helper alone did is work the chat did, and a
     * card only a helper touched was on no chat at all (bw-7ks.22.7).
     */
    const record = findRecord(summary.externalId);
    const helpers = record === null ? [] : helpersOf(record);
    for (const helper of helpers) {
      for (const entry of helper.entries) {
        if (entry.kind === 'call') links.observe(entry.name, entry.input);
      }
    }
    this.saySpend(summary.id, record === null ? messages : allLines(record), helpers);

    const shown = past.slice(-IMPORTED_MESSAGES);
    if (past.length > shown.length) {
      this.publish(summary.id, {
        type: 'notice',
        // The chat's own memory, drawn as one: it is the same thing to a reader
        // as the conversation folding itself up (bw-jkh2.5).
        family: 'memory',
        // For him: rows he can see are missing is the one thing he cannot find
        // out any other way (bw-6jq5).
        audience: 'you',
        text: `${past.length - shown.length} earlier messages and commands are in this chat and are not drawn here.`,
      });
    }
    // A helper is drawn where its own call is, so its turns nest under it the
    // way the live wire nests them. One whose call fell off the end of what is
    // drawn is drawn first instead: the panel is every agent the chat sent off,
    // and a row missing from it is the same silence this card is about.
    const onPage = new Set(shown.flatMap((entry) => (entry.kind === 'call' ? [entry.id] : [])));
    /**
     * How each of the chat's own calls came back — read from the WHOLE record
     * and not only the part drawn, because a helper whose call fell off the end
     * is drawn all the same.
     *
     * A helper's own record says what it did and never whether it worked; the
     * answer is on the call that sent it, which the reading already worked out
     * from the same `is_error` the live driver reads to choose done from failed.
     * Without it a chat watched live shows a failed helper red and the same chat
     * reopened later shows it green (bw-7ks.22.28).
     */
    const wentWell = new Map<string, boolean>();
    for (const entry of past) if (entry.kind === 'call') wentWell.set(entry.id, entry.ok);
    const howItWent = (helper: HelperPast): boolean =>
      helper.toolCallId === null ? true : (wentWell.get(helper.toolCallId) ?? true);

    const byCall = new Map<string, HelperPast>();
    for (const helper of helpers) {
      if (helper.toolCallId !== null && onPage.has(helper.toolCallId)) byCall.set(helper.toolCallId, helper);
      else this.drawHelper(summary.id, helper, howItWent(helper));
    }
    for (const entry of shown) {
      this.draw(summary.id, entry);
      const helper = entry.kind === 'call' ? byCall.get(entry.id) : undefined;
      if (helper) this.drawHelper(summary.id, helper, howItWent(helper));
    }
    leaveMark();
    return read;
  }

  /**
   * One agent the chat sent off, said in the events the live wire would have
   * carried: the row, then its whole conversation stamped with the call that
   * sent it, then what it came back with.
   *
   * Its turns carry that call and so nest under it, which is the same
   * attribution the driver puts on a helper's words as they arrive
   * (bw-7ks.22.2) and the same one the pane reads to open a row's own
   * conversation (bw-7ks.22.4). Nothing here is a second way of drawing a
   * helper; it is the one way, fed from disk instead of from the wire.
   *
   * A helper the kit wrote no meta for has no call to hang off. Its row is
   * still drawn — it ran, and it spent what it spent — and its conversation
   * hangs off its own name, which is what the pane falls back to. Nothing says
   * how that one went either, so it is read the kind way.
   */
  private drawHelper(sessionId: string, helper: HelperPast, ok: boolean): void {
    const under = helper.toolCallId ?? helper.agentId;
    this.publish(sessionId, {
      type: 'agent.started',
      agentId: helper.agentId,
      toolCallId: helper.toolCallId,
      // Every helper with a record of its own is an agent: the kit gives a
      // command left running no conversation to write down.
      kind: 'helper',
      what: helper.what,
      agentType: helper.agentType,
      model: helper.model,
    });
    // The tail of it: a first reading of a chat draws the last few turns of
    // each of its own messages, and a helper's conversation is no different.
    for (const entry of helper.entries.slice(-IMPORTED_MESSAGES)) this.draw(sessionId, entry, under);
    this.publish(sessionId, {
      type: 'agent.finished',
      agentId: helper.agentId,
      // Whether it worked is on the call that sent it, not in its own record —
      // the same answer the live wire gives, so a chat reopened says what it
      // said while it was running (bw-7ks.22.28).
      state: ok ? 'done' : 'failed',
      seconds: helper.seconds,
      tokens: helper.tokens,
      calls: helper.calls,
      model: helper.model,
      result: helper.result,
    });
  }

  /**
   * One row of a record, said in the events that would have carried it live —
   * so a command read off the disk and one watched as it ran open the same way
   * (docs/agent-workbench.md §8.2.4).
   */
  private draw(sessionId: string, entry: PastEntry, parent: string | null = null, already = false): void {
    if (entry.kind === 'said') {
      for (const e of spokenAsEvents(entry, randomUUID(), parent)) this.publish(sessionId, e);
      return;
    }
    // `already` when the call was drawn as running on an earlier beat: it is
    // one row, and it settles where it stands rather than being said twice
    // (bw-jaoz.5).
    if (!already) this.announce(sessionId, entry, parent);
    this.publish(sessionId, {
      type: 'tool.completed',
      toolCallId: entry.id,
      ok: entry.ok,
      output: cut(entry.output),
    });
  }

  /**
   * A call put on the screen, with nothing back from it yet.
   *
   * Its own step, because a record being followed says a call was made a beat
   * or two before it says what the call printed — and the reader is entitled to
   * see the command in between (bw-jaoz.5).
   */
  private announce(sessionId: string, entry: Extract<PastEntry, { kind: 'call' }>, parent: string | null = null): void {
    // Trimmed once, and named off the trimmed copy, so a chat read back out of
    // the record says what a chat watched live says (bw-7ks.24.6).
    const shown = trimInput(entry.input);
    this.publish(sessionId, {
      type: 'tool.started',
      toolCallId: entry.id,
      name: entry.name,
      input: shown,
      title: toolTitle(entry.name, shown),
      parentToolCallId: parent,
    });
    // A change is read off the same arguments the live watcher reads it off, so
    // an edit in an imported chat is drawn as a change rather than as the new
    // text alone — which is what the manager was looking at when he said there
    // was no diff (bw-4wcd.1).
    const change = diffOf(entry.name, entry.input);
    if (change) this.publish(sessionId, { type: 'diff', toolCallId: entry.id, ...change });
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
   * What a chat found on disk has spent, counting every agent it sent off.
   *
   * A chat nothing here is driving has no result message to read a figure off,
   * so until now it showed no spend at all — and the one figure the kit does
   * report to a driver, its dollars, is only ever about the run that is
   * happening. This is the record's own arithmetic instead: every turn the chat
   * itself was answered on, plus the whole of every helper's own file, which is
   * where the delegated work's spend lives and where nothing was looking
   * (bw-7ks.22.8).
   *
   * Tokens and not dollars, because tokens are what the record states. The kit
   * prices nothing into a conversation's file, and a price worked out here from
   * a table of our own would be a guess wearing a dollar sign. A live chat goes
   * on saying the kit's own dollars, which already count what it delegated
   * (measured against the kit's per-model totals, 2026-08-20: a delegated turn
   * reported $0.2399167, exactly its own $0.232197 plus the helper's $0.007720).
   *
   * Each turn counted once, which it was not: the kit writes one answer into
   * the record as several lines — its thinking, its words, each of its calls —
   * and every one of them repeats that answer's usage, so adding the lines up
   * billed a turn once per block it was made of and this chip read 36 percent
   * high on the manager's own record (token-picture.ts, bw-3ug7).
   *
   * Said only when it moves, like the fullness beside it: a chat is re-read
   * whenever anyone looks at it, and repeating a figure grows the record and
   * tells the reader nothing.
   */
  private saySpend(sessionId: string, messages: readonly Recorded[], helpers: readonly HelperPast[]): void {
    const spent = taskSpend(messages, helpers);
    // The chip's two halves: everything that went into the calls — words sent,
    // words kept ready and words read back — against the words written.
    const wentIn = (split: Split): number => split.input + split.cacheWrite + split.cacheRead;
    const input = wentIn(spent.total);
    const output = spent.total.output;
    const total = spent.total.total;
    // Nothing to say rather than a conversation that cost nothing: a record
    // whose turns state no usage is a record we cannot read a spend out of.
    if (total === 0) return;
    if (this.spend.get(sessionId) === total) return;
    this.spend.set(sessionId, total);
    this.publish(sessionId, { type: 'cost', cost: { kind: 'tokens', input, output, total } });
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
    if (conversation && (runningNow(true).has(conversation) || runningCodexThreads().has(conversation.toLowerCase()))) throw new Error(HELD_ELSEWHERE);
  }

  private heldElsewhere(summary: SessionSummary): boolean {
    return summary.externalId !== null && (summary.brand === 'codex'
      ? runningCodexThreads().has(summary.externalId.toLowerCase())
      : runningNow(true).has(summary.externalId));
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
    if (summary.brand === 'codex') {
      let reading = false;
      const look = async (): Promise<void> => {
        if (reading || this.drivers.has(summary.id)) return;
        reading = true;
        try {
          const working = runningCodexThreads().has(externalId.toLowerCase());
          this.publish(summary.id, { type: 'session.state', state: working ? 'thinking' : 'idle', label: working ? 'Working elsewhere' : 'Ready' });
          await this.importPast(summary, working);
        } finally { reading = false; }
      };
      const beat = setInterval(() => void look(), FOLLOW_BEAT_MS);
      beat.unref?.();
      this.followers.set(summary.id, () => clearInterval(beat));
      void look();
      return;
    }
    const path = findRecord(externalId);
    if (path === null) return; // No record on this machine to follow.

    const tail = new RecordTail(path);
    // Where reading starts, settled before the first beat reads a byte: a
    // record that grows in between is read from here and not from where it has
    // got to by then. Awaited rather than launched, because a beat that got in
    // first would find the tail still at zero and read the whole record
    // (bw-uiyz.19).
    const placed = (async (): Promise<void> => {
      if (read.at === null) await tail.toEnd();
      else tail.seek(read.at);
    })();
    // Lines the import already took in, thrown away by name the first time they
    // come round again.
    let through = read.at === null ? null : read.through;
    let carry = read.carry;
    let drawn = read.drawn;
    let reading = false;
    // Its own, because the session has no driver and so no linker in the map:
    // the cards and reports a command names are found here or not at all.
    const links = new Linker(summary.id, summary.cwd, (e) => this.publish(summary.id, e));

    /**
     * What this chat is running, said the way a chat this app drives says it.
     *
     * The model and the mode reached the screen from two events, and both are
     * published only where this app drives the agent. A chat begun in a terminal
     * is followed and never driven, so it drew neither for its whole life — and
     * the guess on its store row is the OWNER'S settings, which say nothing
     * about the terminal that chat is actually running in (bw-ja9l.2).
     *
     * Its record says both, so the follower reads them from there and announces
     * them as `session.pinned` — the event the pickers and the header already
     * fold. Said again whenever either changes, so a terminal switched into
     * another mode says so on the screen as it happens.
     */
    const runs = saysWhatItRuns(({ permissionMode, model }) =>
      this.publish(summary.id, { type: 'session.pinned', permissionMode, model }));
    // Once as the watching starts, over the record as it already stands: a
    // terminal that has not changed mode since it opened writes nothing further
    // about it, so a reader waiting for the next line would wait for ever.
    //
    // It reads the whole record, so it is the slow one, and it is the one that
    // may not overwrite: `caughtUp` fills a blank and nothing else, or a
    // terminal switched a moment after the click has its beat's answer rubbed
    // out by this one's older snapshot (bw-ja9l.5).
    void runningIn(path)
      .then(runs.caughtUp)
      // Being written this instant, or moved: the beat below reads it again.
      .catch(() => {});

    /**
     * Every agent this chat has sent off, and how much of each one is drawn.
     *
     * A helper's turns are in a file of its own beside the record, and the tail
     * this follower reads is the record. So a chat somebody else was driving
     * grew rows for its own commands and never one for an agent it sent off
     * while the reader watched: the row appeared only if the reader shut the
     * chat and opened it again (bw-7ks.22.19).
     *
     * Seeded with what is on disk at the click, all of it counted as drawn: the
     * reading that just ran drew exactly those, and drawing them again would
     * say every turn of every agent twice.
     */
    const sentOff = new Map<string, { size: number; drawn: number; over: boolean }>();
    /**
     * Calls drawn as running, waiting on the answer that ends their row.
     *
     * The settling rule holds back a record's trailing calls until something
     * follows them, so that nothing is ever drawn finished and empty. The cost
     * was that a two-minute command was two minutes of blank chat, in a chat
     * the manager could watch working in a terminal beside it. Held back from
     * SETTLING is not the same as held back from the screen: these are put up
     * as running, and settle in place when the answer lands (bw-jaoz.5).
     */
    const announced = new Map<string, { since: number; told: number }>();
    /**
     * Ends every row still drawn as running.
     *
     * Nothing else will: this follower is the only thing that would have
     * settled them, and it is stopping — the record was rewritten under it, or
     * this app has taken the chat over. A row left running would spin for as
     * long as the chat is open.
     */
    const settleAnnounced = (): void => {
      for (const id of announced.keys()) {
        this.publish(summary.id, { type: 'tool.completed', toolCallId: id, ok: true, output: '' });
      }
      announced.clear();
    };
    /**
     * How long each running row has been running.
     *
     * The row shows a timer only when it is given one, and the record says
     * nothing at all about a call between making it and its answer landing — so
     * a command that takes two minutes would sit at nothing for two minutes.
     *
     * Once every ten seconds, not every beat: the log IS the transcript
     * (§8.2.2), and a command left running overnight would otherwise write
     * twenty thousand lines into the chat the reader scrolls.
     */
    const tellHowLong = (): void => {
      const now = Date.now();
      for (const [id, run] of announced) {
        if (now - run.told < PROGRESS_BEAT_MS) continue;
        run.told = now;
        this.publish(summary.id, {
          type: 'tool.progress',
          toolCallId: id,
          seconds: Math.max(0, Math.round((now - run.since) / 1000)),
        });
      }
    };
    /** Which agent each call sent off, so the answer to that call ends its row. */
    const startedBy = new Map<string, string>();
    for (const [agentId, size] of helpersNow(path)) {
      const helper = helperNamed(path, agentId);
      sentOff.set(agentId, { size, drawn: helper?.entries.length ?? 0, over: false });
      if (helper?.toolCallId) startedBy.set(helper.toolCallId, agentId);
    }

    /** The turns of one agent the reader has not been shown, and its numbers. */
    const sayTurns = (helper: HelperPast, size: number, over: boolean): void => {
      const under = helper.toolCallId ?? helper.agentId;
      for (const entry of helper.entries.slice(sentOff.get(helper.agentId)?.drawn ?? 0)) {
        if (entry.kind === 'call') links.observe(entry.name, entry.input);
        this.draw(summary.id, entry, under);
      }
      sentOff.set(helper.agentId, { size, drawn: helper.entries.length, over });
    };

    /**
     * The agents that have gone off, or said something more, since the last beat.
     *
     * A listing and one stat each, and a file is read only when it has grown —
     * so a chat whose agents are quiet costs about what a chat with none does.
     * Looked at before the record's own tail, so a call that settles this beat
     * already has its row to end.
     */
    const lookAtSentOff = (): void => {
      for (const [agentId, size] of helpersNow(path)) {
        const had = sentOff.get(agentId);
        if (had && had.size === size) continue;
        const helper = helperNamed(path, agentId);
        if (!helper) continue;
        if (!had) {
          this.publish(summary.id, {
            type: 'agent.started',
            agentId: helper.agentId,
            toolCallId: helper.toolCallId,
            kind: 'helper',
            what: helper.what,
            agentType: helper.agentType,
            model: helper.model,
          });
          if (helper.toolCallId !== null) startedBy.set(helper.toolCallId, agentId);
        }
        sayTurns(helper, size, had?.over ?? false);
        // Its own file says what it has spent and how long it has been at it,
        // and says nothing anywhere about being finished: it is running until
        // the chat gets its answer back.
        this.publish(summary.id, {
          type: 'agent.progress',
          agentId: helper.agentId,
          seconds: helper.seconds,
          tokens: helper.tokens,
          calls: helper.calls,
          model: helper.model ?? undefined,
          state: had?.over ? undefined : 'running',
        });
      }
    };

    /**
     * The answer to a call landing, which is the only thing that says an agent
     * is over: nothing in its own file marks a last line as last.
     */
    const answered = (callId: string, ok: boolean): void => {
      const agentId = startedBy.get(callId);
      if (agentId === undefined || sentOff.get(agentId)?.over) return;
      const helper = helperNamed(path, agentId);
      if (helper === null) return;
      sayTurns(helper, helpersNow(path).get(agentId) ?? 0, true);
      this.publish(summary.id, {
        type: 'agent.finished',
        agentId,
        // How it went is on the answer to that call — the same signal the live
        // wire reads — and never in the helper's own file, which says what it
        // did and stops there (bw-7ks.22.28).
        state: ok ? 'done' : 'failed',
        seconds: helper.seconds,
        tokens: helper.tokens,
        calls: helper.calls,
        model: helper.model,
        result: helper.result,
      });
    };

    /**
     * The byte the lines now in hand begin at — the ones in `carry` when there
     * are any, and otherwise the next ones to arrive. Minus one while it is not
     * known, which is the one beat where lines are being dropped by name.
     */
    let carryAt = -1;
    let markedAt = -1;
    let markedDrawn = -1;
    /**
     * Leaves the mark a later open carries on from: the byte, and how many rows
     * of what stands there are already drawn (bw-uiyz.19).
     *
     * The rows are half of it because the busiest chats are never settled — a
     * record being written ends in commands whose answers have not landed, and
     * those rows wait for them. A mark that named a byte alone was never
     * written for exactly the chats the manager watches.
     */
    const mark = (): void => {
      if (carryAt < 0) return;
      // Written only when it has moved: a chat nothing is happening in is
      // looked at every beat, and saying the same thing again is a write to the
      // store for no reader.
      if (carryAt === markedAt && drawn === markedDrawn) return;
      markedAt = carryAt;
      markedDrawn = drawn;
      this.store.rememberFollowed(summary.id, markedAt, markedDrawn, IMPORT_RECIPE);
    };

    const draw = async (): Promise<void> => {
      // Where the lines this look is about to read begin, taken before it reads
      // them.
      const from = tail.throughLine;
      const grown = await tail.grown();
      // Compaction rewrites the record shorter than it was. What is already
      // drawn stays drawn — it is the only copy of those turns — and reading
      // carries on from the new end rather than replaying it as if it were new.
      if (grown.rewritten) {
        settleAnnounced();
        carry = [];
        drawn = 0;
        through = null;
        await tail.toEnd();
        carryAt = tail.throughLine;
        mark();
        return;
      }
      // Before the early return below: a terminal switched into another mode
      // writes that line and no conversation, and the screen has to follow it.
      runs.beat(grown.running);
      let fresh = grown.fresh;
      // Nothing held back yet, so these lines are the first this follower has
      // in hand and `from` is where they begin.
      const holding = carry.length > 0;
      if (!holding) carryAt = from;
      if (through !== null) {
        const already = fresh.findIndex((line) => line.uuid === through);
        if (already !== -1) {
          const had = fresh.slice(0, already + 1);
          fresh = fresh.slice(already + 1);
          if (holding) {
            // The rows held back cover these same lines: taking them again
            // would say each of them twice.
            carryAt = -1;
          } else {
            // Kept and counted rather than thrown away. Their rows are on the
            // screen either way; keeping the LINES is what keeps `carryAt`
            // meaningful, and a byte a later open can carry on from is the
            // whole point of the mark (bw-uiyz.19).
            carry = had;
            drawn = pastTranscript(had).length;
          }
        }
        through = null;
      }
      if (fresh.length === 0) {
        mark();
        return;
      }
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
        carryAt = tail.throughLine;
      } else {
        carry = all;
        drawn = upto;
      }
      for (const entry of said) {
        if (entry.kind === 'call') links.observe(entry.name, entry.input);
        // A call already on the screen as running settles where it stands
        // rather than being drawn a second time (bw-jaoz.5).
        this.draw(summary.id, entry, null, entry.kind === 'call' && announced.delete(entry.id));
        if (entry.kind === 'call') answered(entry.id, entry.ok);
      }
      // And the tail the settling rule held back, put up as running.
      for (const entry of entries.slice(upto)) {
        if (entry.kind !== 'call' || announced.has(entry.id)) continue;
        // Counted from the record's own line rather than from this instant: a
        // reader who opens a chat a minute into a command must be told a
        // minute, not nothing (bw-jaoz.5).
        announced.set(entry.id, { since: entry.at ?? Date.now(), told: 0 });
        links.observe(entry.name, entry.input);
        this.announce(summary.id, entry);
      }
      mark();
    };

    const look = async (): Promise<void> => {
      if (reading) return;
      reading = true;
      try {
        await placed;
        // What it has sent off, before what it has said itself (bw-7ks.22.19).
        lookAtSentOff();
        // The stat inside the read alone says whether there is anything new,
        // whoever wrote it and whether or not that program is still there.
        // Stopping the moment the terminal exited lost every later turn: the
        // manager answers a prompt, walks away, and comes back to a chat that
        // stopped growing at the first answer (bw-4wcd.20).
        await draw();
        tellHowLong();
      } catch {
        // Being written to this instant, or moved: try the next beat.
      } finally {
        reading = false;
      }
    };

    const beat = setInterval(() => void look(), FOLLOW_BEAT_MS);
    // Watching a chat is not a reason for the sidecar to stay up.
    beat.unref?.();
    this.followers.set(summary.id, () => {
      clearInterval(beat);
      settleAnnounced();
    });
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
    // And where the record had been read to is no longer where the drawing has
    // been read to: the driver's own turns go on the screen without passing
    // through the record's byte count, so a later open carrying on from that
    // byte would draw them a second time (bw-uiyz.19).
    this.store.forgetFollowed(summary.id);
    const driver = createDriver(summary.brand);
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
      // An agent being started, which is what background says (bw-jkh2.5) — and
      // the machine's own, because he just typed into this chat and starting it
      // back up is how that gets answered, not news (bw-6jq5).
      this.publish(sessionId, {
        type: 'notice',
        family: 'background',
        audience: 'machine',
        text: 'Continuing this chat.',
      });
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

  answer(sessionId: string, askId: string, optionId: string, value?: string): void {
    this.require(sessionId).answer(askId, optionId as PermissionAnswer, value);
  }

  /**
   * Changes what the OPEN chat is pinned to, and keeps the choice against that
   * chat: the mode and the model are both re-pinned on every resume (§3.1), so
   * a change made here has to outlive the chat going to sleep.
   *
   * It acts on this chat and stops there. It used to write the pick back into
   * the owner's own settings so the next chat opened on it, and he asked for
   * that to stop: "every new chat should start on the plain default, whatever I
   * picked last" (bw-7ojj). Two things were wrong with it. A chat he had left
   * on one model quietly took on his latest pick the moment he typed into it,
   * because a chat with no model of its own asks the kit to resolve one and the
   * kit reads that same file. And the file it reached for first is his own
   * global one, the one every terminal on the machine reads, so picking a model
   * in a chat here changed what his next terminal started on.
   *
   * His settings are still READ — a brand new chat opens on what they say
   * (`start`) — and nothing in the app writes to them any more.
   */
  async pin(sessionId: string, what: { mode?: string; model?: string }): Promise<void> {
    const driver = this.require(sessionId);
    if (what.mode !== undefined) {
      await driver.setMode(what.mode);
      this.store.updateSession(sessionId, { permissionMode: what.mode });
    }
    if (what.model !== undefined) {
      await driver.setModel(what.model);
      this.store.updateSession(sessionId, { model: what.model === BRAND_DEFAULT_MODEL ? null : what.model });
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
   * Ends the chat itself, and keeps every word of it.
   *
   * The opposite of `stop` above, not a louder version of it: that one cuts the
   * answer in flight so the chat can be typed into again, and this one takes the
   * agent away for good. Nothing is deleted — the row stays in the list, reads
   * `Ended`, and opens again on a click like any sleeping chat (the manager,
   * 2026-08-25).
   *
   * `require` is deliberately not used. Most of the list has no driver attached,
   * and a chat that is merely asleep is exactly the one somebody tidies away;
   * refusing those would leave the control drawn on rows it could not act on.
   * The state is published either way, and publishing it is what writes `ended`
   * onto the row — see `publish`, which already knows that falling asleep and
   * ending are not activity and must not move the row up the list.
   */
  async close(sessionId: string): Promise<void> {
    const summary = this.store.getSession(sessionId);
    if (!summary) throw new Error(`no session ${sessionId}`);
    // Already over. Said a second time it would put another `session.state` in
    // the record and another frame on every stream, for nothing that changed.
    if (summary.state === 'ended') return;

    const driver = this.drivers.get(sessionId);
    // Let go first, and whatever the teardown does: a driver that fails to shut
    // down is still one this app must stop speaking to, or a chat whose agent
    // is wedged could never be ended at all.
    this.drivers.delete(sessionId);
    this.linkers.delete(sessionId);
    this.unfollow(sessionId);

    let failed: string | null = null;
    try {
      await driver?.close();
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    if (failed !== null) {
      // Written into the chat's own record rather than thrown back at the
      // screen. The chat IS ended — this app has let go of it — so a refusal
      // would say the opposite of what happened. What it actually cost is that
      // the brand's own process may still be standing, and that belongs in the
      // conversation it belongs to.
      this.publish(sessionId, {
        type: 'error',
        message: `the agent did not shut down cleanly: ${failed}`,
        fatal: false,
      });
    }
    this.publish(sessionId, { type: 'session.state', state: 'ended', label: 'Ended' });
  }

  /**
   * Ends ONE piece of sent-off work. The chat keeps its turn and everything
   * else it sent away keeps running (docs/agent-workbench.md §8.2.7).
   */
  async stopAgent(sessionId: string, agentId: string): Promise<void> {
    const driver = this.require(sessionId);
    if (!driver.stopAgent) throw new Error(`this chat's brand cannot stop one agent`);
    await driver.stopAgent(agentId);
  }

  /** Hands the turn back and lets the work run on. False when there was none in flight. */
  async parkAgent(sessionId: string, agentId: string): Promise<boolean> {
    const driver = this.require(sessionId);
    if (!driver.parkAgent) throw new Error(`this chat's brand cannot park one agent`);
    return driver.parkAgent(agentId);
  }

  /**
   * A word typed for an agent that is already running.
   *
   * It goes to the CHAT that sent the agent, naming which agent it is for,
   * because that is the only road either brand offers — neither gives anyone a
   * private input channel into a helper in flight, and this does not pretend to
   * have one (docs/agent-workbench.md §8.2.7). The turn is sent first and the
   * row marked after, so a row never claims a relay that never left.
   */
  async relay(sessionId: string, agentId: string, text: string): Promise<void> {
    await this.send(
      sessionId,
      `A message for the agent you sent off (id ${agentId}), from the person watching this chat. ` +
        `It could not be handed to it directly, so it comes to you:\n\n${text}`,
    );
    this.publish(sessionId, { type: 'agent.relayed', agentId, text });
  }

  /**
   * Both halves of one chat's token picture: its window now, its spend ever.
   *
   * The window can only come from whoever is driving the chat, so it is asked
   * of our own driver and of nothing else. A chat being READ — from its record,
   * or followed while another program drives it — gets the plain sentence
   * instead of a figure: the app knows what that chat's turns cost and cannot
   * know what its next prompt is made of, and inventing a breakdown from the
   * record would be a guess drawn as a measurement (decision 13, bw-3ug7).
   *
   * The spend is the other way round: read from the chat's own file, so it
   * works for any chat at all, live or long finished, and spans every time the
   * conversation forgot itself — which is the whole reason the reader is
   * asking, the gauge having dropped back to nothing at each of them.
   */
  async tokenPicture(sessionId: string): Promise<TokenPicture> {
    const driver = this.drivers.get(sessionId);
    let window = null;
    let windowNote: string | null = NOT_OURS_TO_ASK;
    if (driver?.windowNow) {
      try {
        window = readWindow((await driver.windowNow()) as Parameters<typeof readWindow>[0]);
        windowNote = window ? null : 'The program driving this chat did not say what is in its window.';
      } catch {
        // A chat dying mid-question loses this answer and nothing else.
        windowNote = 'This chat could not be asked what is in its window just now.';
      }
    } else if (driver) {
      windowNote = "This chat's brand cannot say what is in its window.";
    }

    const summary = this.store.getSession(sessionId);
    if (summary?.brand === 'codex') {
      const events = this.store.eventsSince(sessionId, 0);
      const cost = [...events].reverse().find((event) => event.type === 'cost' && event.cost.kind === 'tokens');
      if (!cost || cost.type !== 'cost' || cost.cost.kind !== 'tokens') {
        return { window, windowNote, spent: null, spentNote: 'Codex has not reported token usage for this chat yet.' };
      }
      const own: Split = {
        input: cost.cost.input, cacheWrite: 0, cacheRead: 0, output: cost.cost.output,
        thinking: 0, total: cost.cost.total,
      };
      const turns = events.filter((event) => event.type === 'message.completed' && events.some(
        (start) => start.type === 'message.started' && start.messageId === event.messageId && start.role === 'assistant',
      )).length;
      const spent: TaskSpend = {
        own, helpers: NOTHING, total: own, turns,
        toolCalls: events.filter((event) => event.type === 'tool.started').length,
        forgettings: events.filter((event) => event.type === 'note' && (event.kind === 'thread/compacted' || event.kind === 'compact')).length,
        helperCount: events.filter((event) => event.type === 'agent.started').length,
        models: [{ model: summary.model ?? 'unnamed', spend: own, turns }],
      };
      return { window, windowNote, spent, spentNote: null };
    }
    const record = summary?.externalId ? findRecord(summary.externalId) : null;
    if (record === null) {
      return { window, windowNote, spent: null, spentNote: 'This chat has no record on disk yet.' };
    }
    const lines = allLines(record);
    if (lines.length === 0) {
      return { window, windowNote, spent: null, spentNote: "This chat's record could not be read." };
    }
    return { window, windowNote, spent: taskSpend(lines, helpersOf(record)), spentNote: null };
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
    } else if (full.type === 'session.pinned') {
      // The mode is re-pinned on every resume from what is stored (§3.1), so a
      // mode the tool changed by itself — approving a plan ends plan mode — has
      // to be written down here or the chat wakes up back in the old one
      // (bw-1u1.43).
      if (full.permissionMode !== null) {
        this.store.updateSession(sessionId, { permissionMode: full.permissionMode });
      }
      // And the model for the same reason. This event is also how a chat this
      // app does not drive says what it is running, read from its own record by
      // the follower — which the app knew and threw away, so the chat came back
      // with no model of its own and had one resolved for it (bw-7ojj).
      if (full.model !== null) this.store.updateSession(sessionId, { model: full.model });
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

  /**
   * A chat somebody has started reading, however they arrived at it.
   *
   * Watching a chat this app does not drive is what puts the chat's own record
   * on the screen: what it is running, and every line it grows while the reader
   * is there. That watching was only ever started from one place — the click on
   * a sleeping row in the list — and the address bar is the other way in. So a
   * chat opened by its own address, and a click on a chat already working,
   * which the list hands straight to the screen without asking us, both drew a
   * header that said nothing and a conversation that never grew (bw-ja9l.8).
   *
   * The stream starts it instead, which is the half that was missing:
   * `subscribe` below already stops the watching when the last reader leaves.
   * A chat this app is driving needs none of it — its driver is the one writing
   * the record this would be reading.
   */
  async lookedAt(sessionId: string): Promise<void> {
    // Nothing here may throw: the stream starts this and does not wait for it,
    // so a rejection nobody is holding would take the whole helper down with it
    // (bw-ja9l.9).
    try {
      const summary = this.store.getSession(sessionId);
      if (!summary) return;
      if (this.drivers.has(sessionId) || this.followers.has(sessionId)) return;
      const live = this.heldElsewhere(summary);
      this.follow(summary, await this.importPast(summary, live));
    } catch {
      // A record that has been moved, pruned, or never written. The chat still
      // has whatever this app stored for it, and that is what the reader is
      // shown; a click handles the same thing the same way.
    }
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
