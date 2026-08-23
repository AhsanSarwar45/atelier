'use client';

/**
 * The one connection this window holds to the app.
 *
 * A browser allows six connections to one address ACROSS EVERY WINDOW it has,
 * and an event stream never gives its slot back. The app used to open one per
 * feed — the helper's own stream from the top bar, the project's board file
 * wherever the card list was drawn, the open chat — so two or three windows
 * spent the whole budget, and every ordinary read then queued behind streams
 * that would never end. That is what a screen stuck on loading was, and why
 * reloading it worked: a reload frees that window's streams, and the reads go
 * out before the streams reopen (bw-zkh4).
 *
 * So every feed is asked for here, and the server fans them in: one route
 * carries all of them, each event tagged with the feed it came from
 * (server/src/routes/live.rs). This part owns the connection; the status bar,
 * the card list and the open chat read from it by tag and never open one.
 *
 * What is watched changes as the reader moves — a project is opened, a chat is
 * clicked — and the connection is asked again with the new shape. Never two at
 * once: the old one is closed before the new one is opened, so the count this
 * window costs is one whatever is on screen. The chat carries the number of the
 * last thing it drew, so a re-ask never replays a conversation onto itself.
 */

import { apiUrl } from '@/lib/api-base';

/** One board change, as the server reports it. */
export interface WatchEvent {
  path: string;
  type: string;
}

/** Told when the project's board moved. */
type BoardListener = (event: WatchEvent) => void;

/** Told what the helper says about every chat at once. */
interface WorkbenchListener {
  /** One frame, still as text: the reader of it decides what it can read. */
  frame: (data: string) => void;
  /** The connection went away, so what was said about live chats is a memory. */
  dropped: () => void;
}

/** Told about one chat: the conversation as it stands, then the live tail. */
interface ChatListener {
  snapshot: (data: string) => void;
  event: (data: string) => void;
  /**
   * The last event this reader has drawn, asked for at the moment the
   * connection is opened. Asking from zero would send the whole conversation a
   * second time, and fold it onto itself.
   */
  since: () => number;
}

const boards = new Map<string, Set<BoardListener>>();
const workbenchers = new Set<WorkbenchListener>();
const chats = new Map<string, Set<ChatListener>>();

let source: EventSource | null = null;
/** The shape the open connection was opened with, so a change is visible. */
let asked = '';
/** A reshape is already queued; several hooks mounting cost one open. */
let reshaping = false;

/**
 * How long after a dropped connection before it is opened again, and the
 * ceiling that wait climbs to.
 *
 * The same numbers the helper's own stream used before this file existed: the
 * app may be stopped, or restarting after an update, so this backs off rather
 * than hammering a door nobody is behind — and never stops trying, because a
 * server that comes back is the ordinary case.
 */
const AGAIN_MS = 2_000;
const AGAIN_CEILING_MS = 30_000;
let againIn = AGAIN_MS;
let again: ReturnType<typeof setTimeout> | null = null;

/**
 * What this window is watching, as the route takes it.
 *
 * More than one board is joined by a newline rather than repeated, because a
 * repeated key is the one thing a query string cannot say plainly to the server
 * (server/src/routes/live.rs). A project path never contains one.
 */
function shape(): string {
  const params = new URLSearchParams();
  if (boards.size > 0) params.set('board', Array.from(boards.keys()).join('\n'));
  if (workbenchers.size > 0) params.set('workbench', '1');
  const chat = openChat();
  if (chat) {
    params.set('chat', chat);
    params.set('since', String(furthestSeen(chat)));
  }
  return params.toString();
}

/**
 * The chat being read. One at a time: the chat tab draws the conversation the
 * address names, and there is one address. A second would need the server to
 * carry two chat feeds and the frames to say which chat each belongs to, and
 * nothing on screen asks for that.
 */
function openChat(): string | null {
  const open = Array.from(chats.keys());
  return open.length === 0 ? null : open[open.length - 1];
}

/** How far the readers of a chat have already drawn it. */
function furthestSeen(chat: string): number {
  let seen = 0;
  chats.get(chat)?.forEach((listener) => {
    seen = Math.max(seen, listener.since());
  });
  return seen;
}

/** Whoever is listening for a board change under `path`. */
function boardsUnder(path: string): Set<BoardListener>[] {
  const told: Set<BoardListener>[] = [];
  boards.forEach((listeners, project) => {
    // The server reports the file that moved — the board file itself, or the
    // database directory — which is always inside the project asked about.
    if (path === project || path.startsWith(project.endsWith('/') ? project : `${project}/`)) {
      told.push(listeners);
    }
  });
  return told;
}

function close(): void {
  source?.close();
  source = null;
  asked = '';
}

/**
 * The connection went away. Everything reading it is told, because a fact that
 * arrived on a stream that has stopped speaking is a memory rather than an
 * answer, and then it is opened again.
 */
function dropped(): void {
  close();
  workbenchers.forEach((w) => w.dropped());
  if (again !== null) return;
  if (nothingWanted()) return;
  again = setTimeout(() => {
    again = null;
    againIn = Math.min(againIn * 2, AGAIN_CEILING_MS);
    open();
  }, againIn);
}

function nothingWanted(): boolean {
  return boards.size === 0 && workbenchers.size === 0 && chats.size === 0;
}

/** Opens the one connection, or reopens it in the shape now wanted. */
function open(): void {
  const want = shape();
  if (source && want === asked) return;
  close();
  if (!want) return;
  // Drawn where there is no connection to be had at all — a server render, a
  // test bench. Those simply hear nothing.
  if (typeof EventSource === 'undefined') return;

  asked = want;
  source = new EventSource(apiUrl(`/api/live?${want}`));

  source.addEventListener('board', (msg) => {
    spoke();
    try {
      const said = JSON.parse((msg as MessageEvent).data) as WatchEvent;
      for (const listeners of boardsUnder(said.path)) listeners.forEach((tell) => tell(said));
    } catch {
      // A frame this window cannot read is not worth the whole connection.
    }
  });

  source.addEventListener('workbench', (msg) => {
    spoke();
    workbenchers.forEach((w) => w.frame((msg as MessageEvent).data));
  });

  source.addEventListener('chat', (msg) => {
    spoke();
    const chat = openChat();
    if (chat) chats.get(chat)?.forEach((c) => c.event((msg as MessageEvent).data));
  });

  source.addEventListener('chat.snapshot', (msg) => {
    spoke();
    const chat = openChat();
    if (chat) chats.get(chat)?.forEach((c) => c.snapshot((msg as MessageEvent).data));
  });

  source.onerror = dropped;
}

/** Speaking again: the next drop starts its count from the short wait. */
function spoke(): void {
  againIn = AGAIN_MS;
}

/**
 * What is watched has changed, so the connection is asked again for it.
 *
 * The first one goes out at once — a screen waiting on a feed should not wait a
 * turn for it. Every reshape after that waits for this paint to finish, because
 * three hooks mounting together is the ordinary case and each of them tearing
 * the connection down to open its own is exactly the churn this file exists to
 * remove.
 */
function reshape(): void {
  // Let go of it the moment nothing on screen is watching, rather than a turn
  // later: a connection nobody is reading is a slot somebody else's read wants.
  if (nothingWanted()) {
    close();
    stopWaiting();
    return;
  }
  if (source === null) {
    // Whatever wait was counting down towards reopening it, this is the reopen.
    stopWaiting();
    open();
    return;
  }
  if (reshaping) return;
  reshaping = true;
  queueMicrotask(() => {
    reshaping = false;
    if (nothingWanted()) {
      close();
      stopWaiting();
      return;
    }
    open();
  });
}

/** Forgets a wait that was counting down towards opening it again. */
function stopWaiting(): void {
  if (again !== null) {
    clearTimeout(again);
    again = null;
  }
  againIn = AGAIN_MS;
}

/** Watch one project's board. Returns the way to stop. */
export function onBoard(project: string, tell: BoardListener): () => void {
  const listeners = boards.get(project) ?? new Set<BoardListener>();
  listeners.add(tell);
  boards.set(project, listeners);
  reshape();
  return () => {
    listeners.delete(tell);
    if (listeners.size === 0) boards.delete(project);
    reshape();
  };
}

/** Watch what the helper says about every chat at once. */
export function onWorkbench(listener: WorkbenchListener): () => void {
  workbenchers.add(listener);
  reshape();
  return () => {
    workbenchers.delete(listener);
    reshape();
  };
}

/** Watch one chat: the conversation as it stands, then the live tail. */
export function onChat(chat: string, listener: ChatListener): () => void {
  const listeners = chats.get(chat) ?? new Set<ChatListener>();
  listeners.add(listener);
  chats.set(chat, listeners);
  reshape();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) chats.delete(chat);
    reshape();
  };
}

/**
 * How many connections this window is holding. One, or none — which is the
 * whole point, and what the test of it asserts.
 */
export function streamsOpen(): number {
  return source ? 1 : 0;
}

/** What the open connection is watching, for a test to read. */
export function watching(): string {
  return asked;
}

/** Forgets everything, so one test's connection is not another's. */
export function forgetEverything(): void {
  boards.clear();
  workbenchers.clear();
  chats.clear();
  close();
  if (again !== null) {
    clearTimeout(again);
    again = null;
  }
  againIn = AGAIN_MS;
}
