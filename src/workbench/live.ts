/**
 * Every running chat, in one place, from one connection.
 *
 * The waiting-on-you tray, the glance strip and the live dot on a board card
 * are three views of the same fact — what each session is doing right now — so
 * they share a single module-level store rather than each opening its own
 * (docs/agent-workbench.md §8.6). The idiom is the repo's own:
 * `useSyncExternalStore` over a listener set, as in `use-theme.ts`.
 *
 * The connection under that store is not this file's any more. It is the one
 * connection the whole window holds, and this reads the helper's frames off it
 * by tag (live-wire.ts, bw-zkh4).
 */
'use client';

import { useMemo, useSyncExternalStore } from 'react';

import { chatState, counting, type ChatState, type HeldChat } from '@/workbench/chat-state';
import { onWorkbench } from '@/workbench/live-wire';
import { NOTHING_KNOWN, type PlanUsage } from '@/workbench/plan-usage';
import type { Brand, SessionState, SessionSummary, WatchFrame } from '@/workbench/protocol';

/** What one chat is doing, as every global view needs it. */
export interface LiveSession {
  id: string;
  brand: Brand;
  /**
   * The tool's own id for the conversation, which is the name the running set
   * is written in — so a view that has this need not wait on the chat's own
   * facts, which are a board query and most of a second, to know whether
   * somebody else is in it (bw-dmxj.8).
   */
  externalId: string | null;
  projectId: string;
  projectPath: string;
  title: string | null;
  state: SessionState;
  /** The agent's own words for what it is doing — "Asking about Edit", "Answering". */
  activity: string;
  /** What it is waiting for, when it is waiting on the owner. */
  waitingFor: string | null;
  lastActiveAt: string;
  /**
   * When it started doing what it is doing, or `null` when it is doing nothing
   * that takes time.
   *
   * Its own clock, separate from `lastActiveAt`: that one moves on every line
   * of an answer, and counting from it would show a two-minute read as one
   * second. Restarted when the WORDS change and not merely the kind of work,
   * which is the same rule the open chat's own line follows (bw-f1q.17,
   * bw-96is).
   */
  busySince: string | null;
  /**
   * When the person himself last spoke in this chat, or `null` if nothing here
   * has ever heard him.
   *
   * The clock the chat list is ordered by, so it moves on his own message and
   * on nothing the agent then does — that is the whole of what keeps a row
   * still while an agent writes in it (protocol.ts, whenHeSpoke; bw-zhs9).
   */
  lastSpokeAt: string | null;
  startedAt: string;
  /** Cards this chat has touched, as the machine recorded them. */
  beads: string[];
}

/**
 * The one reading (chat-state.ts) for a chat in this store.
 *
 * No holder is passed: every view over this store lists chats an agent of ours
 * is attached to, and a held chat is by definition one where ours is not
 * (heldElsewhere). The chat's own screen is where the two meet.
 */
export function liveState(s: LiveSession): ChatState {
  return chatState({
    state: s.state,
    label: s.activity,
    since: s.busySince === null ? null : Date.parse(s.busySince),
  });
}

/**
 * Blocked on the human, and nothing else. The tray is a filter over the state
 * and never a list of its own, so a state that stops meaning "your turn" leaves
 * the tray by deleting it here (protocol.ts, SessionState).
 */
export function waitsOnYou(s: LiveSession): boolean {
  return s.state === 'waiting_permission' || s.state === 'ended' || s.state === 'errored';
}

/** Working right now: the glance strip's whole condition. */
export function isRunning(s: LiveSession): boolean {
  return s.state === 'thinking' || s.state === 'streaming' || s.state === 'running_tool';
}

/**
 * Attached and alive — working, or stopped mid-turn waiting for you. What a
 * board card means by "being worked on": a chat holding a permission card is
 * the most alive thing on the board, not the least.
 */
export function isLive(s: LiveSession): boolean {
  return isRunning(s) || s.state === 'waiting_permission' || s.state === 'idle' || s.state === 'starting';
}

const listeners = new Set<() => void>();
let sessions: LiveSession[] = [];
/** How to stop reading the helper's feed off the window's one connection. */
let stop: (() => void) | null = null;
/** Rebuilt on every change so `useSyncExternalStore` sees a new reference. */
let snapshot: LiveSession[] = sessions;
/**
 * The conversations a live process is holding, by the tool's own id.
 *
 * `null` until the stream has said — which is not the same as "none", and the
 * difference matters: the list arrives from a fetch already marked, and an
 * empty set would rub those marks out before the stream had spoken.
 */
let running: Set<string> | null = null;
/**
 * What each of those conversations is doing, by the same id, `null` until the
 * stream has said for the same reason as above.
 *
 * Held apart from the set because the set is what the writing box turns on —
 * one question, answered the same way it always was — while this is what the
 * screen draws, and a screen that cannot say what a chat is doing must still
 * be able to say that somebody is in there (bw-96is).
 */
let holds: Map<string, HeldChat> | null = null;
/**
 * The stream has said who is holding chats at least once since this page was
 * loaded, which is a different question from whether it is speaking now.
 *
 * The two together are what a screen needs to be honest after a drop. `holds`
 * goes back to null when the connection dies, and null means "nobody has said"
 * — so every screen falls back to the answer it was handed when it was built:
 * the open chat to the facts it fetched when the chat was opened, a row to the
 * list it fetched when the list was drawn. Before the stream has ever spoken
 * those are the freshest thing there is. After it has spoken and gone away
 * they are older than what was just thrown out, and a held chat would start
 * spinning again and count its seconds from a moment long gone (bw-96is.22).
 */
let saidWhoHolds = false;
/**
 * The helper on the other end of the stream is not saying what this page reads.
 *
 * It is one process, started once, and nothing restarts it when its own code
 * changes (bw-kr4m) — so a page served after an update talks to a helper from
 * before it. The morning this was written the helper had been up since 10:51
 * and the page since 13:48, and the word for who is holding a chat had changed
 * cargo in between: the page read a field the old helper does not send, threw
 * inside its own message handler, and from that moment said NOTHING about any
 * held chat — no moving mark, no badge — for as long as the tab stayed open.
 * Every other fact went on arriving, so the screen looked healthy and was
 * simply, permanently wrong about the one thing this job is about (bw-96is.24).
 *
 * So a frame this page cannot read is a fact about the helper rather than a
 * crash: it is said out loud on the screen, the rest of the stream is left
 * working, and it clears itself the moment a frame arrives that does read —
 * which is what a restarted helper sends, so the tab heals without a reload.
 */
let mismatched = false;
/**
 * How many times the stream has said the tools' own session folders moved, for
 * each project anybody is watching.
 *
 * Never rows, and never a list: the frame is a bare word (protocol.ts,
 * WatchFrame) because `restoreList` on the sidecar is the one place that builds
 * rows. A number that only climbs is the smallest thing a view can watch — what
 * it stands at means nothing, a change in it means "ask for the list again"
 * (bw-uivp.2).
 *
 * One count per project rather than one for the machine, because the word now
 * says which working directories moved: a screen showing one project ignores
 * the writing agents do in every other, which on this machine was four full
 * list rebuilds in twelve idle seconds for work that had nothing to do with
 * what was on screen (bw-uivp.4).
 */
const heardOutside = new Map<string, number>();

/**
 * What the account has spent of its plan, as the sidecar last said it.
 *
 * Pushed down the same stream as everything else here and never asked for: the
 * figure is the ACCOUNT'S, so it cannot be a property of the chat on screen,
 * and a page that polled for it showed a chat sitting silent a different number
 * from the one being worked in (bw-dmoe). Nothing known until the stream
 * speaks, which the chip draws as no chip at all rather than as a zero.
 */
const usage = new Map<Brand, PlanUsage>([['claude', NOTHING_KNOWN], ['codex', NOTHING_KNOWN]]);

/** A project starts being counted for the moment something asks about it. */
function countFor(project: string): number {
  return heardOutside.get(project) ?? 0;
}

/**
 * Whether writing in `where` is writing this project cares about.
 *
 * A project's own chats are not only the ones run in its folder: a job is built
 * in a copy of the tree beside it, and those chats belong to the same project
 * on screen, so anything under the folder counts.
 */
function inside(project: string, where: string): boolean {
  return where === project || where.startsWith(project.endsWith('/') ? project : `${project}/`);
}

/**
 * The word arrived. Every project it could be about hears it; a word the
 * sidecar could not place is about all of them (protocol.ts, WatchFrame).
 */
function heard(folders: string[] | undefined): void {
  const bare = !folders || folders.length === 0;
  for (const project of Array.from(heardOutside.keys())) {
    if (bare || folders.some((where) => inside(project, where))) {
      heardOutside.set(project, countFor(project) + 1);
    }
  }
  listeners.forEach((fn) => fn());
}

function announce(): void {
  snapshot = sessions;
  listeners.forEach((fn) => fn());
}

function fromSummary(s: SessionSummary & { activity: string; beads: string[] }): LiveSession {
  return {
    id: s.id,
    brand: s.brand,
    externalId: s.externalId,
    projectId: s.projectId,
    projectPath: s.projectPath,
    title: s.title,
    state: s.state,
    activity: s.activity,
    waitingFor: null,
    lastActiveAt: s.lastActiveAt,
    // Nothing in the list says when the turn began, so a chat found already
    // working counts from the last thing it was seen to do. That is the moment
    // its state was last published, which is what the count means anyway.
    busySince: counting(s.state) ? s.lastActiveAt : null,
    lastSpokeAt: s.lastSpokeAt ?? null,
    startedAt: s.createdAt,
    beads: s.beads,
  };
}

function patch(id: string, change: Partial<LiveSession>): void {
  const at = sessions.findIndex((s) => s.id === id);
  if (at < 0) return;
  sessions = sessions.map((s, i) => (i === at ? { ...s, ...change } : s));
}

/**
 * Whether a chat's own clock moves on this event.
 *
 * Opening a conversation replays the whole of it onto this stream, every
 * message stamped with the moment it was read — and this took each of those
 * for activity, so reading a chat from March carried it to the top of the list
 * under today's time. The sidecar has always refused to stamp the row for a
 * read (workbench/src/store.ts, `touch`); this is that same rule on this side
 * of the wire. A sleeping chat did nothing, whatever is coming down its log
 * (bw-4wcd.9).
 */
export function movesTheClock(state: SessionState | undefined): boolean {
  return state !== undefined && state !== 'dormant' && state !== 'ended';
}

function moves(id: string, next?: SessionState): boolean {
  return movesTheClock(next ?? sessions.find((s) => s.id === id)?.state);
}

/**
 * Where the seconds on a chip count from, once a state event has landed.
 *
 * Three screens draw that number — the row in the list, the glance strip and a
 * board card — and all three read it from here, so what a chat has been at for
 * forty seconds says forty on every one of them.
 *
 * The rule is the piece of work, not the event: two reads in a row are both
 * `running_tool` with the same words, and restarting on the second would show a
 * forty-second turn as one. The same state carrying the same label is the same
 * piece of work, so the count carries on; anything else is a new one and starts
 * where it arrived (bw-f1q.17).
 *
 * Pulled out of the switch it lives in and made pure, because a mistake in it
 * is silent — a wrong number is still a number, on three screens at once, and
 * nothing exercised it (bw-96is.12).
 */
export function countingFrom(
  had: { state: SessionState; activity: string; busySince: string | null } | undefined,
  now: { state: SessionState; label: string; at: string },
): string | null {
  // Not working, so nothing to count; a chat waiting on the reader counts too,
  // which is what `counting` decides.
  if (!counting(now.state)) return null;
  const same = had && had.state === now.state && had.activity === now.label;
  return same ? (had.busySince ?? now.at) : now.at;
}

/**
 * Say, or stop saying, that the helper is not speaking this page's words.
 *
 * Only on a change, because it is read through the same subscription every
 * other fact on this stream is and a helper that is out of step is out of step
 * on every frame it sends.
 */
function noteMismatch(now: boolean): void {
  if (mismatched === now) return;
  mismatched = now;
  announce();
}

function absorb(frame: WatchFrame): void {
  if (frame.kind === 'usage') {
    usage.set(frame.brand ?? 'claude', frame.usage);
    listeners.forEach((fn) => fn());
    return;
  }
  if (frame.kind === 'running') {
    // An older helper sends this same word carrying the old cargo — a list of
    // bare ids where this reads a list of chats and what each is doing. Read
    // blind it threw, and a throw here is invisible: the page went on drawing
    // everything else and never said another word about a held chat.
    //
    // What is known is then nothing, and `null` is how this file spells that
    // everywhere else — the same answer a dropped stream gives, and for the
    // same reason. Keeping a memory would let the writing box open on a chat
    // somebody is in (bw-dmxj.12).
    if (!Array.isArray(frame.holds)) {
      running = null;
      holds = null;
      mismatched = true;
      announce();
      return;
    }
    noteMismatch(false);
    running = new Set(frame.holds.map((h) => h.id));
    holds = new Map(frame.holds.map((h) => [h.id, h]));
    saidWhoHolds = true;
    announce();
    return;
  }
  if (frame.kind === 'snapshot') {
    sessions = frame.sessions.map(fromSummary);
    announce();
    // The sidecar stops watching the tools' folders the moment the last browser
    // leaves, so nothing was heard while this one was away and a chat begun in
    // that gap would have stayed invisible until some unrelated write happened
    // to shake the list. A stream that has just come back is itself the word
    // (bw-uivp.5).
    if (missedSomething) {
      missedSomething = false;
      heard(undefined);
    }
    return;
  }
  if (frame.kind === 'outside') {
    // The tools' own session folders moved: a chat was begun or worked in
    // somewhere that is not this app. No session in this store changed — the
    // frame carries none — so the sessions are left exactly as they are and the
    // only thing published is that the word was said. The chat list is what
    // answers it, by asking for the list again (chat-sidebar.tsx, bw-uivp.2).
    heard(frame.folders);
    return;
  }
  if (frame.kind === 'opened') {
    if (!sessions.some((s) => s.id === frame.session.id)) {
      sessions = [...sessions, fromSummary(frame.session)];
      announce();
    }
    return;
  }
  const e = frame.event;
  // A session started while we were watching is not in the snapshot; it joins
  // the list on the first event that says what it is.
  if (e.type === 'session.started' && !sessions.some((s) => s.id === e.sessionId)) {
    sessions = [
      ...sessions,
      {
        id: e.sessionId,
        brand: e.brand,
        // The event says a chat exists, not what the tool calls it; the
        // snapshot that follows carries that.
        externalId: null,
        projectId: '',
        projectPath: e.cwd,
        title: null,
        state: 'starting',
        activity: '',
        waitingFor: null,
        busySince: e.at,
        // A chat that has just come into being has not been spoken in yet; the
        // message he sends it arrives on its own event, below.
        lastSpokeAt: null,
        startedAt: e.at,
        lastActiveAt: e.at,
        beads: [],
      },
    ];
  }

  switch (e.type) {
    // The one event that moves the list's own clock. Everything else in this
    // switch is the agent working — a reply, a question about a tool, a card it
    // linked — and the point of the second clock is that none of it disturbs
    // the order the manager is reading (bw-zhs9).
    case 'message.started':
      if (e.role !== 'user') return;
      // A chat being read replays his old messages onto this stream, each one
      // stamped with the moment it was read. A sleeping chat did nothing,
      // whatever is coming down its log (movesTheClock, bw-4wcd.9).
      if (!moves(e.sessionId)) return;
      patch(e.sessionId, { lastSpokeAt: e.at, lastActiveAt: e.at });
      break;
    case 'session.state': {
      const had = sessions.find((s) => s.id === e.sessionId);
      patch(e.sessionId, {
        state: e.state,
        activity: e.label,
        busySince: countingFrom(had, { state: e.state, label: e.label, at: e.at }),
        ...(moves(e.sessionId, e.state) ? { lastActiveAt: e.at } : {}),
      });
      break;
    }
    case 'ask.permission':
      patch(e.sessionId, { waitingFor: e.title, lastActiveAt: e.at });
      break;
    case 'ask.resolved':
      patch(e.sessionId, { waitingFor: null, lastActiveAt: e.at });
      break;
    case 'text.delta':
      if (!moves(e.sessionId)) return;
      patch(e.sessionId, { lastActiveAt: e.at });
      break;
    case 'link.bead': {
      const had = sessions.find((s) => s.id === e.sessionId)?.beads ?? [];
      if (had.includes(e.beadId)) return;
      patch(e.sessionId, {
        beads: [...had, e.beadId],
        ...(moves(e.sessionId) ? { lastActiveAt: e.at } : {}),
      });
      break;
    }
    case 'error':
      patch(e.sessionId, { waitingFor: e.message, lastActiveAt: e.at });
      break;
    default:
      return;
  }
  announce();
}

/**
 * The stream has been away, so what happened outside this app while it was gone
 * was said to nobody. Cleared by the snapshot that comes back.
 */
let missedSomething = false;

/**
 * The stream has stopped speaking, so what it said about who is working is no
 * longer an answer — it is a memory.
 *
 * Back to `null`, which every reader of it treats as "not yet said" and answers
 * from the chat's own facts instead. Keeping the last set would be worse than
 * knowing nothing: a chat that started being worked in after the drop would be
 * drawn as free, and the writing box would let a reader wake a second agent on
 * somebody else's conversation (bw-dmxj.12). The server refuses that outright,
 * which is what actually holds the door; this is the screen telling the truth
 * about what it knows.
 */
function dropped(): void {
  missedSomething = true;
  // Both, together. What each held chat is DOING is the half that goes stale
  // visibly: the mark keeps spinning and its seconds keep climbing on the last
  // thing a dead connection said, for up to half a minute of retrying, and
  // nothing on screen tells the two apart from a live one. Whether a chat is
  // held at all is dropped for the older reason — the writing box reads it, and
  // a chat somebody started working in after this would be missing from it
  // (bw-dmxj.12). Neither is an answer once nobody is speaking (bw-96is.22).
  if (running !== null || holds !== null) {
    running = null;
    holds = null;
    announce();
  }
  // Opening it again is the wire's job, and it keeps its own count: this
  // store is one reader of a connection the whole window shares.
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  stop ??= onWorkbench({
    frame: (data) => {
      try {
        absorb(JSON.parse(data) as WatchFrame);
      } catch {
        // Whatever else a helper of another age can send that this cannot read,
        // it gets the same answer as the frame checked by hand above: the page
        // says the helper does not match and goes on reading the frames it does
        // understand, rather than dying inside a handler nobody is watching
        // (bw-96is.24).
        noteMismatch(true);
      }
    },
    dropped,
  });
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

const EMPTY: LiveSession[] = [];

/** Every chat the app knows about, live. */
export function useLiveSessions(): LiveSession[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
}

/**
 * What the account has spent of its plan, kept fresh by the sidecar.
 *
 * Every page holding this stream is told the same figure at the same moment, so
 * two chats side by side — one being worked in, one silent for an hour — read
 * the same number, and the silent one moves while the other spends. No screen
 * asks for it and no chat's traffic decides how fresh it is (bw-dmoe).
 */
export function usePlanUsage(brand: Brand = 'claude'): PlanUsage {
  return useSyncExternalStore(
    subscribe,
    () => usage.get(brand) ?? NOTHING_KNOWN,
    () => NOTHING_KNOWN,
  );
}

/**
 * Whether the helper feeding this stream is out of step with the page reading
 * it — almost always because it is still running the code it started with while
 * the page has been served since (bw-kr4m).
 *
 * Worth a line on the screen rather than a line in a log, because what it costs
 * is silent: the page keeps drawing, and the only sign is that no chat anybody
 * is working in ever says so. A reader with no line to read concludes the
 * feature does not work (bw-96is.24).
 */
export function useHelperMismatch(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => mismatched,
    () => false,
  );
}

/**
 * The conversations somebody is working in right now, by the tool's own id, or
 * `null` while the stream has not yet said.
 *
 * These are not this app's sessions. A chat being typed at in a terminal is the
 * one the list most needs to mark and the one it knows least about, so the fact
 * arrives on its own frame rather than on a session's (protocol.ts, WatchFrame).
 */
export function useRunningElsewhere(): Set<string> | null {
  return useSyncExternalStore(
    subscribe,
    () => running,
    () => null,
  );
}

/**
 * What each of those conversations is doing, by the tool's own id, or `null`
 * while the stream has not yet said.
 *
 * The stream is the only place this can come from for a chat nothing of ours
 * drives: it has no session of ours to carry an event and no driver to publish
 * a state (§6.3.4).
 */
export function useHolds(): Map<string, HeldChat> | null {
  return useSyncExternalStore(
    subscribe,
    () => holds,
    () => null,
  );
}

/**
 * What this page still holds about who is in a chat is out of date: the stream
 * has spoken about it before, and is not speaking now.
 *
 * The screens keep their own older answer for the moment the stream has not
 * spoken yet — the open chat the facts it fetched on opening, a row the list it
 * fetched when it was drawn — and that is right exactly once, before anybody
 * has said anything. This is the word for after: keep the badge, because who is
 * in there is not the sort of thing that changes while nobody is looking, and
 * drop what they were doing, because that is precisely the thing that does. A
 * mark that went on turning through half a minute of retrying, counting from a
 * moment minutes gone, is indistinguishable on screen from a chat somebody is
 * really working in (bw-96is.22).
 */
export function useHeldFactsAreOld(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => saidWhoHolds && holds === null,
    () => false,
  );
}

/**
 * How many times the stream has said a chat was begun or worked in outside this
 * app — in Zed, in a terminal, by anything that writes the tools' own session
 * folders.
 *
 * The number itself says nothing; a change in it says "the list you are holding
 * is out of date, ask for it again". A view watches it exactly as the working
 * mark above is watched, and for the same reason: nobody is going to reload a
 * tab to find out that a chat was started somewhere else (bw-uivp).
 *
 * Counted for the project asked about and no other, so agents working in the
 * rest of the machine cost this screen nothing (bw-uivp.4). A stream that has
 * been away and come back counts once for every project, because nothing was
 * heard while it was gone (bw-uivp.5).
 */
export function useHeardFromOutside(project: string): number {
  const watch = useMemo(
    () => (fn: () => void) => {
      if (!heardOutside.has(project)) heardOutside.set(project, 0);
      return subscribe(fn);
    },
    [project],
  );
  return useSyncExternalStore(
    watch,
    () => countFor(project),
    () => 0,
  );
}
