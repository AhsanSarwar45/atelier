/**
 * Every running chat, in one place, from one connection.
 *
 * The waiting-on-you tray, the glance strip and the live dot on a board card
 * are three views of the same fact — what each session is doing right now — so
 * they share a single module-level store over a single EventSource rather than
 * each opening its own (docs/agent-workbench.md §8.6). The idiom is the repo's
 * own: `useSyncExternalStore` over a listener set, as in `use-theme.ts`.
 */
'use client';

import { useMemo, useSyncExternalStore } from 'react';

import { apiUrl } from '@/lib/api-base';
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
let source: EventSource | null = null;
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

function absorb(frame: WatchFrame): void {
  if (frame.kind === 'running') {
    running = new Set(frame.conversations);
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
    case 'session.state':
      patch(e.sessionId, {
        state: e.state,
        activity: e.label,
        ...(moves(e.sessionId, e.state) ? { lastActiveAt: e.at } : {}),
      });
      break;
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
 * How long after a dropped stream we try again, and the ceiling it climbs to.
 *
 * The workbench may not be running at all — the board half of the app works
 * without it — so the wait doubles up to half a minute rather than hammering a
 * door nobody is behind. It never stops trying: a sidecar that comes back is
 * the ordinary case (a rebuild, a restart), and until it does the screen is
 * working from facts that stopped moving.
 */
const RETRY_MS = 2_000;
const RETRY_CEILING_MS = 30_000;
let retryIn = RETRY_MS;
let retrying: ReturnType<typeof setTimeout> | null = null;
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
  source?.close();
  source = null;
  missedSomething = true;
  if (running !== null) {
    running = null;
    announce();
  }
  if (retrying !== null || listeners.size === 0) return;
  retrying = setTimeout(() => {
    retrying = null;
    retryIn = Math.min(retryIn * 2, RETRY_CEILING_MS);
    connect();
  }, retryIn);
}

function connect(): void {
  if (source) return;
  // A card is drawn in places with no live connection to be had at all — a
  // server render, a test bench. Those simply see no sessions.
  if (typeof EventSource === 'undefined') return;
  if (listeners.size === 0) return;
  source = new EventSource(apiUrl('/api/workbench/watch'));
  source.onmessage = (msg) => {
    // Speaking again: the next drop starts its own count from the short wait.
    retryIn = RETRY_MS;
    absorb(JSON.parse(msg.data) as WatchFrame);
  };
  source.onerror = dropped;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      source?.close();
      source = null;
      if (retrying !== null) {
        clearTimeout(retrying);
        retrying = null;
      }
      retryIn = RETRY_MS;
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
