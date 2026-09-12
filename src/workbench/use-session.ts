/**
 * One chat session in the browser: the SSE subscription and the view it folds
 * events into.
 *
 * The conversation itself — what an event does to it — lives in fold.ts, which
 * the sidecar runs too. Opening receives only the newest server-built window;
 * older windows are prepended on demand, and this hook folds only the live tail.
 * A dropped stream resumes from the last event drawn (docs/agent-workbench.md §4).
 *
 * The connection is not this file's: the chat is one tag on the one connection
 * the window holds, and the number of the last event drawn is what that
 * connection carries when it is asked again (live-wire.ts, bw-zkh4).
 */
'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { request } from '@/lib/api';
import { keepFile } from '@/workbench/attachment-store';
import { looksLikeAPicture } from '@/workbench/composer-attachments';
import { pictureShape } from '@/workbench/picture-shape';
import { onChat } from '@/workbench/live-wire';
import { asView, EMPTY, reduce, type SessionView } from '@/workbench/fold';
import type { ImagePayload, SessionFacts, SessionState, WbpCommand, WbpEvent } from '@/workbench/protocol';

export {
  EMPTY,
  foldAll,
  reduce,
  type SessionMenu,
  type SessionView,
  type TranscriptAsk,
  type TranscriptItem,
  type TranscriptMessage,
  type TranscriptNote,
  type TranscriptNotice,
  type TranscriptThinking,
  type TranscriptTool,
} from '@/workbench/fold';


/** Reads a picked or pasted file into the shape the protocol carries. */
export function readImage(file: File): Promise<ImagePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read the picture'));
    reader.onload = () =>
      resolve({ mime: file.type, dataUrl: String(reader.result), alt: file.name });
    reader.readAsDataURL(file);
  });
}

/**
 * The same file, read and then handed to the store to keep.
 *
 * The bytes stay on the payload as well, so the writing box can draw the file
 * the instant it is chosen without waiting for a round trip. They are dropped
 * on the way out — what is sent, and so what the log keeps, is the name alone
 * (`promptFromDraft`).
 *
 * A picture the store cannot take is not fatal: it keeps its own bytes and
 * behaves exactly as it did before there was a store, which is worse but is not
 * nothing. Nothing else gets that fallback. A picture is small and is drawn
 * from what it carries; a refused archive or video would be a hundred megabytes
 * of base64 riding in the record for a file the reader cannot even see, which
 * is the thing bw-oamr.5 took out of it. So it is refused out loud instead.
 */
export async function readAndKeep(file: File): Promise<ImagePayload> {
  const read = await readImage(file);
  // Measured here, while the bytes are still in hand: once it is in the store
  // there is no header left to read, and a picture with no shape cannot have
  // its place held open before it decodes (bw-cdav.3). Only a picture has one.
  const shape = pictureShape(read.dataUrl);
  try {
    const kept = await keepFile(file.name || 'the attached file', read.dataUrl);
    return { ...read, asset: kept.asset, size: kept.size, ...(shape ?? {}) };
  } catch (e) {
    if (!looksLikeAPicture(file)) throw e;
    return read;
  }
}

/**
 * What to put in front of the reader when the sidecar says no.
 *
 * A refusal is often a rule rather than a fault — the chat belongs to another
 * program for the moment (sessions.ts, HELD_ELSEWHERE) — and those are written
 * to be read. The status line is kept only for the failures that carry no words
 * of their own.
 */
async function refusal(res: Response, command: string): Promise<string> {
  const body = await res.text();
  try {
    const said = JSON.parse(body) as { error?: unknown };
    if (typeof said.error === 'string' && said.error) return said.error;
  } catch {
    // Not JSON: the raw body is all there is.
  }
  // Some refusals come from the layer beneath ours and carry no words meant for
  // a reader. A person attaching pictures was shown 'prompt.send failed: 413
  // Failed to buffer the request body: length limit exceeded' — the web
  // server's own words for a rule this app never set, naming an internal
  // command, with nothing in it to act on (bw-ad3r.4). Those are said again
  // here in the reader's terms; anything else keeps the status line, which is
  // better than silence.
  const plainly = PLAINLY[res.status];
  if (plainly) return plainly;
  return `${command} failed: ${res.status} ${body}`;
}

/** What the statuses that arrive without readable words of their own mean. */
const PLAINLY: Record<number, string> = {
  // The body limit is off for the routes that carry attachments, so this should
  // no longer be reachable from the writing box. It stays because the thing it
  // guards against — a request too large for something between here and the
  // server — is not ours to promise away.
  413: 'That was too large to send. Try it with fewer pictures attached.',
  401: 'This app no longer recognises you. Reload the page.',
  403: 'This chat is not yours to write to at the moment.',
  404: 'That chat is no longer there.',
  502: 'The server is not answering. It may still be starting up.',
  503: 'The server is not answering. It may still be starting up.',
  504: 'The server took too long to answer.',
};

export async function sendCommand<T = unknown>(cmd: WbpCommand): Promise<T> {
  const res = await request('/api/workbench/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(await refusal(res, cmd.type));
  return (await res.json()) as T;
}

/**
 * What the open chat says about itself: the cards it has worked on and where it
 * is working. Asked once per chat — the cards come from the board, so a chat
 * begun in a terminal carries them the first time it is opened, not only after
 * this app has watched it work.
 */
/** What a chat said about itself, and when it was asked (ms since the epoch). */
export interface SessionFactsRead {
  facts: SessionFacts;
  at: number;
}

const sessionFactsCache = new Map<string, SessionFactsRead>();

export function useSessionFacts(sessionId: string | null): SessionFacts | null {
  return useSessionFactsRead(sessionId)?.facts ?? null;
}

/**
 * The same facts, with the moment they were read. The moment matters to one
 * reader: the writing box, which weighs them against a running set the stream
 * may have taken before them (running.ts, streamStillAnswers).
 */
export function useSessionFactsRead(sessionId: string | null): SessionFactsRead | null {
  const factsCache = sessionFactsCache;
  const [facts, setFacts] = useState<SessionFactsRead | null>(() => sessionId ? factsCache.get(sessionId) ?? null : null);

  useEffect(() => {
    // Cleared first, so the line never names the chat before this one.
    setFacts(sessionId ? factsCache.get(sessionId) ?? null : null);
    if (!sessionId) return;
    if (factsCache.has(sessionId)) return;
    let live = true;
    void (async () => {
      try {
        const res = await request(`/api/workbench/session/${encodeURIComponent(sessionId)}`);
        if (live && res.ok) {
          const found = { facts: (await res.json()) as SessionFacts, at: Date.now() };
          factsCache.set(sessionId, found);
          setFacts(found);
        }
      } catch {
        // The header falls back to what the stream itself carries.
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId]);

  return facts;
}

export interface HistoryLoad {
  /** Unique transcript items prepended by this cursor request. */
  added: number;
  /** Whether another cursor page exists after this one. */
  hasOlder: boolean;
}

export type LoadedSessionView = SessionView & {
  /** The chat shell is open, but its newest item page has not arrived yet. */
  loading: boolean;
  loadOlder: (() => Promise<HistoryLoad>) | null;
};

interface CachedSession {
  view: SessionView;
  ready: boolean;
  /** Live tail frames that arrived before the opening item page. */
  pending: WbpEvent[];
  listeners: Set<() => void>;
  notifyFrame: number | null;
  loadingOlder: boolean;
  touched: number;
}

const SESSION_CACHE_LIMIT = 10;
const cachedSessions = new Map<string, CachedSession>();

function cached(id: string): CachedSession {
  let entry = cachedSessions.get(id);
  if (!entry) {
    entry = {
      view: EMPTY, ready: false, pending: [], listeners: new Set(), notifyFrame: null,
      loadingOlder: false, touched: Date.now(),
    };
    cachedSessions.set(id, entry);
    if (cachedSessions.size > SESSION_CACHE_LIMIT) {
      const oldest = Array.from(cachedSessions.entries())
        .filter(([key]) => key !== id)
        .sort((a, b) => a[1].touched - b[1].touched)[0];
      if (oldest) cachedSessions.delete(oldest[0]);
    }
  }
  entry.touched = Date.now();
  return entry;
}

function publishCached(id: string, view: SessionView, ready?: boolean, immediate = false): void {
  const entry = cached(id);
  entry.view = view;
  if (ready !== undefined) entry.ready = ready;
  const notify = () => {
    entry.notifyFrame = null;
    entry.listeners.forEach((listener) => listener());
  };
  // A streamed answer can carry dozens of deltas in one paint. Keep folding
  // every one in order, but let React and the virtualizer observe the final
  // state once per frame. Snapshots and history prepends are immediate because
  // they replace the loading shell or preserve a scroll anchor before paint.
  if (immediate || process.env.NODE_ENV === 'test' || typeof requestAnimationFrame !== 'function') {
    if (entry.notifyFrame !== null) cancelAnimationFrame(entry.notifyFrame);
    notify();
  } else if (entry.notifyFrame === null) {
    entry.notifyFrame = requestAnimationFrame(notify);
  }
}

/** The app-wide feed keeps chats already opened current while another tab is
 * visible, so switching back needs no catch-up reconstruction. */
export function cacheSessionEvent(event: WbpEvent): void {
  const entry = cachedSessions.get(event.sessionId);
  if (!entry || event.seq <= entry.view.lastSeq) return;
  if (!entry.ready) {
    // The app-wide feed can beat the selected chat's opening snapshot. Keep
    // that tail until the snapshot supplies the page it follows.
    if (!entry.pending.some((pending) => pending.seq === event.seq)) entry.pending.push(event);
    return;
  }
  // Once open, the transcript has its own ordered, resumable chat feed.
  // Folding the same event from the app-wide sidebar feed races two independent
  // relays and can advance lastSeq past an earlier chat frame. Keep the global
  // feed only as catch-up for cached chats that are not currently being read.
  if (entry.listeners.size > 0) return;
  publishCached(event.sessionId, reduce(entry.view, event));
}

/**
 * A fresh snapshot, with the older pages the reader had already pulled in.
 *
 * The snapshot is the newest window the sidecar holds, and publishing it as-is
 * threw away every older page the reader had scrolled back through: the
 * transcript jumped forwards under them and what they were reading was gone
 * (bw-ad3r.12). The snapshot's own first row says where the two meet — what
 * sits above it here is history this browser fetched and the snapshot simply
 * does not reach back to, so it is kept, along with the cursor saying how far
 * back the reader had got.
 *
 * Where the two do not meet — a disconnection long enough that the new window
 * starts after everything held — there is nothing to join and the snapshot
 * stands alone.
 */
export function keepingHistoryAlreadyRead(had: SessionView, fresh: SessionView): SessionView {
  if (!had.items.length || !fresh.items.length) return fresh;
  const name = (item: SessionView['items'][number]) => `${item.kind}:${item.id}`;
  const meet = had.items.findIndex((item) => name(item) === name(fresh.items[0]!));
  if (meet <= 0) return fresh;
  const inFresh = new Set(fresh.items.map(name));
  const kept = had.items.slice(0, meet).filter((item) => !inFresh.has(name(item)));
  if (!kept.length) return fresh;
  return {
    ...fresh,
    items: [...kept, ...fresh.items],
    historyCursor: had.historyCursor,
    hasOlder: had.hasOlder,
  };
}

async function loadHistory(id: string): Promise<HistoryLoad> {
  const entry = cached(id);
  if (entry.loadingOlder) return { added: 0, hasOlder: entry.view.hasOlder };
  if (!entry.view.hasOlder || entry.view.historyCursor === null) return { added: 0, hasOlder: false };
  entry.loadingOlder = true;
  try {
    const before = entry.view.historyCursor;
    const res = await request(`/api/workbench/history?session=${encodeURIComponent(id)}&before=${before}`);
    if (!res.ok) return { added: 0, hasOlder: entry.view.hasOlder };
    const page = (await res.json()) as { items: SessionView['items']; cursor: number | null; hasOlder: boolean };
    const existing = new Set(entry.view.items.map((item) => `${item.kind}:${item.id}`));
    const added = page.items.filter((item) => !existing.has(`${item.kind}:${item.id}`));
    const hasOlder = page.cursor !== before && page.hasOlder;
    publishCached(id, {
      ...entry.view,
      items: [...added, ...entry.view.items],
      historyCursor: page.cursor,
      // A cursor that did not move cannot be asked forever. Treat that broken
      // page as the head rather than turning one observer into a replay loop.
      hasOlder,
    }, undefined, true);
    return { added: added.length, hasOlder };
  } finally {
    entry.loadingOlder = false;
  }
}

export function useSession(sessionId: string | null): LoadedSessionView {
  const subscribe = useCallback((listener: () => void) => {
    if (!sessionId) return () => {};
    const entry = cached(sessionId);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }, [sessionId]);
  const snapshot = useCallback(
    () => sessionId ? cached(sessionId).view : EMPTY,
    [sessionId],
  );
  const view = useSyncExternalStore(
    subscribe,
    snapshot,
    () => EMPTY,
  );

  useEffect(() => {
    if (!sessionId) return;
    const entry = cached(sessionId);

    return onChat(sessionId, {
      // What the connection asks from when it is opened, or opened again after
      // a drop. Asking from zero would send the whole conversation a second
      // time, and fold it onto itself.
      // A live frame may reach the app-wide cache before this chat's opening
      // page. It is buffered below; asking from its seq would make the server
      // skip the snapshot and leave the loading shell standing forever.
      since: () => entry.ready ? entry.view.lastSeq : 0,

      // The newest conversation window as the sidecar built it. Older windows
      // are fetched only when the reader reaches the top.
      snapshot: (data) => {
        try {
          // Filled against a blank chat rather than trusted: the sidecar is a
          // process that outlives this page, so it can be older than the screen
          // and simply not send a list the screen draws (bw-7ks.22.16).
          const opening = asView(JSON.parse(data) as Partial<SessionView>);
          const complete = entry.pending
            .filter((event) => event.seq > opening.lastSeq)
            .sort((a, b) => a.seq - b.seq)
            .reduce(reduce, opening);
          entry.pending = [];
          publishCached(sessionId, keepingHistoryAlreadyRead(entry.view, complete), true, true);
          // The snapshot is the newest server-built window. Loading farther
          // back here makes an opened chat grow through its older history
          // before the reader has asked for it, which reads as the transcript
          // replaying from the top. `DrawnTranscript` calls `loadOlder` only
          // after the reader reaches its head.
        } catch {
          // A frame this page cannot read leaves the transcript as it stands.
        }
      },

      error: (data) => {
        try {
          const failure = JSON.parse(data) as { error?: unknown };
          if (typeof failure.error === 'string' && failure.error) {
            // Keep `ready` false: the native relay retries the snapshot in
            // place, and its successful bounded page replaces this diagnosis.
            publishCached(sessionId, { ...entry.view, error: failure.error }, undefined, true);
          }
        } catch {
          // An unreadable diagnosis is no more useful than no diagnosis.
        }
      },

      event: (data) => {
        let event: WbpEvent;
        try {
          event = JSON.parse(data) as WbpEvent;
        } catch {
          return;
        }
        // Ownership is checked again here, after the multiplexed wire routed
        // the frame. A delayed, replayed, or malformed frame cannot enter the
        // selected transcript merely because it arrived on that subscription.
        if (event.sessionId !== sessionId) return;
        if (!entry.ready) {
          if (!entry.pending.some((pending) => pending.seq === event.seq)) entry.pending.push(event);
          return;
        }
        if (event.seq > entry.view.lastSeq) publishCached(sessionId, reduce(entry.view, event));
      },
    });
  }, [sessionId]);

  const requestOlder = useCallback(
    () => sessionId ? loadHistory(sessionId) : Promise.resolve({ added: 0, hasOlder: false }),
    [sessionId],
  );
  return {
    ...view,
    loading: sessionId ? !cached(sessionId).ready : false,
    loadOlder: sessionId && view.hasOlder && view.historyCursor !== null ? requestOlder : null,
  };
}

/** True while the agent owes an answer — the Stop button's condition. */
export function isBusy(state: SessionState): boolean {
  return state === 'thinking' || state === 'streaming' || state === 'waiting_for_agents' || state === 'running_tool' || state === 'waiting_permission';
}

/**
 * Which chat is open is not a state any component holds: it is in the address,
 * and the chat tab reads it there (docs/designs/app-shell.md §1.7). A hook that
 * kept its own copy answered the first link and then quietly disagreed with
 * every one after it — which is what made an open chat unlinkable and Back do
 * nothing (bw-m8o).
 */
