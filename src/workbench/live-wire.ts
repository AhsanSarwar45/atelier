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
 * carries all of them, each frame tagged with the feed it came from
 * (server/src/routes/live.rs). This part owns the connection; the status bar,
 * the card list and the open chat read from it by tag and never open one.
 *
 * And that connection is a socket rather than an event stream, which is what
 * takes it off the budget of six altogether: a browser counts event streams
 * against the six and does not count sockets. One stream per window was still
 * one of the six, so six windows brought the whole fault back; a socket costs
 * the reads nothing, so any number of windows can be open (bw-zkh4.10).
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

let source: WebSocket | null = null;
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

/**
 * Whether `path` is the project itself, or something inside it.
 *
 * Both separators count. The server builds the path it reports by joining onto
 * the project path this window sent it, so on Windows it comes back written the
 * Windows way — `C:\work\proj\.beads\issues.jsonl` under a project of
 * `C:\work\proj`. Looking only for a forward slash after the project's name
 * matched none of those, so every board change was dropped on the floor and a
 * Windows board went on not moving until the page was reloaded: the exact fault
 * this job exists to remove, left standing on one platform (bw-zkh4.13).
 *
 * The project's name has to end where its own does — `/work/proj-two` is not
 * inside `/work/proj` — which is what looking at the character after it is for.
 */
function inside(path: string, project: string): boolean {
  const withoutTrailing = (of: string) => of.replace(/[\\/]+$/, '');
  const child = withoutTrailing(path);
  const parent = withoutTrailing(project);
  if (child === parent) return true;
  if (!child.startsWith(parent)) return false;
  const after = child[parent.length];
  return after === '/' || after === '\\';
}

/** Whoever is listening for a board change under `path`. */
function boardsUnder(path: string): Set<BoardListener>[] {
  const told: Set<BoardListener>[] = [];
  boards.forEach((listeners, project) => {
    // The server reports the file that moved — the board file itself, or the
    // database directory — which is always inside the project asked about.
    if (inside(path, project)) told.push(listeners);
  });
  return told;
}

function close(): void {
  const going = source;
  // Emptied first, so this window hanging up is not read as the connection
  // failing: a socket tells its owner when it closes however it closed, and
  // the two are told apart by whether it is still the one being held.
  source = null;
  asked = '';
  going?.close();
}

/**
 * The address of the one connection.
 *
 * `ws` rather than `http`, and absolute, because a socket has no notion of the
 * page's own address to be relative to.
 */
function wire(want: string): string {
  const path = apiUrl(`/api/live?${want}`);
  const absolute = /^https?:/i.test(path) ? path : new URL(path, window.location.href).toString();
  return absolute.replace(/^http/i, 'ws');
}

/** One frame off the connection: which feed spoke, and what it said. */
interface Frame {
  tag?: string;
  data?: string;
  /** Immutable owner of a chat frame, supplied by the server relay. */
  scope?: string;
}

/** Hands one frame to whoever asked for that feed. */
function heard(raw: string): void {
  spoke();
  let frame: Frame;
  try {
    frame = JSON.parse(raw) as Frame;
  } catch {
    // A frame this window cannot read is not worth the whole connection.
    return;
  }
  const said = frame.data ?? '';
  switch (frame.tag) {
    case 'board': {
      try {
        const moved = JSON.parse(said) as WatchEvent;
        for (const listeners of boardsUnder(moved.path)) listeners.forEach((tell) => tell(moved));
      } catch {
        // As above: one unreadable board frame, not the connection.
      }
      return;
    }
    case 'workbench':
      workbenchers.forEach((w) => w.frame(said));
      return;
    case 'chat': {
      const chat = frame.scope;
      if (chat) chats.get(chat)?.forEach((c) => c.event(said));
      return;
    }
    case 'chat.snapshot': {
      const chat = frame.scope;
      if (chat) chats.get(chat)?.forEach((c) => c.snapshot(said));
      return;
    }
    default:
      // A feed this build does not know about: a newer server, an older page.
      return;
  }
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
  if (typeof WebSocket === 'undefined') return;

  asked = want;
  const socket = new WebSocket(wire(want));
  source = socket;

  socket.onmessage = (msg: MessageEvent) => {
    if (source === socket) heard(String(msg.data));
  };
  // A socket that fails reports both of these, one after the other; a socket
  // this window closed itself is no longer the one being held, so its close
  // says nothing.
  const gone = () => {
    if (source === socket) dropped();
  };
  socket.onclose = gone;
  socket.onerror = gone;
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
  // It is down, and a wait is already counting towards trying again. A screen
  // mounting or unmounting does not make a stopped server answer, and the wait
  // reads what is watched afresh when it fires — so the new shape is carried by
  // the wait that is already running. Cancelling it would put the count back to
  // its floor, and ordinary navigation during an outage would then hammer a
  // door nobody is behind, which is the one thing the backing-off is for
  // (bw-zkh4.9).
  if (again !== null) return;
  if (source === null) {
    // Nothing was waiting: this is the first open, or the first after the
    // reader stopped watching everything. The count starts from its floor.
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
