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
  return `${command} failed: ${res.status} ${body}`;
}

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
const sessionFactsCache = new Map<string, SessionFacts>();

export function useSessionFacts(sessionId: string | null): SessionFacts | null {
  const factsCache = sessionFactsCache;
  const [facts, setFacts] = useState<SessionFacts | null>(() => sessionId ? factsCache.get(sessionId) ?? null : null);

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
          const found = (await res.json()) as SessionFacts;
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

export type LoadedSessionView = SessionView & { loadOlder: (() => Promise<void>) | null };

interface CachedSession {
  view: SessionView;
  listeners: Set<() => void>;
  loadingOlder: boolean;
  touched: number;
}

const SESSION_CACHE_LIMIT = 10;
const cachedSessions = new Map<string, CachedSession>();

function cached(id: string): CachedSession {
  let entry = cachedSessions.get(id);
  if (!entry) {
    entry = { view: EMPTY, listeners: new Set(), loadingOlder: false, touched: Date.now() };
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

function publishCached(id: string, view: SessionView): void {
  const entry = cached(id);
  entry.view = view;
  entry.listeners.forEach((listener) => listener());
}

/** The app-wide feed keeps chats already opened current while another tab is
 * visible, so switching back needs no catch-up reconstruction. */
export function cacheSessionEvent(event: WbpEvent): void {
  const entry = cachedSessions.get(event.sessionId);
  if (!entry || event.seq <= entry.view.lastSeq) return;
  publishCached(event.sessionId, reduce(entry.view, event));
}

async function loadHistory(id: string): Promise<void> {
  const entry = cached(id);
  if (entry.loadingOlder) return;
  if (!entry.view.hasOlder || entry.view.historyCursor === null) return;
  entry.loadingOlder = true;
  try {
    const before = entry.view.historyCursor;
    const res = await request(`/api/workbench/history?session=${encodeURIComponent(id)}&before=${before}`);
    if (!res.ok) return;
    const page = (await res.json()) as { items: SessionView['items']; cursor: number | null; hasOlder: boolean };
    const existing = new Set(entry.view.items.map((item) => `${item.kind}:${item.id}`));
    publishCached(id, {
      ...entry.view,
      items: [...page.items.filter((item) => !existing.has(`${item.kind}:${item.id}`)), ...entry.view.items],
      historyCursor: page.cursor,
      // A cursor that did not move cannot be asked forever. Treat that broken
      // page as the head rather than turning one observer into a replay loop.
      hasOlder: page.cursor !== before && page.hasOlder,
    });
  } finally {
    entry.loadingOlder = false;
  }
}

export function useSession(sessionId: string | null): LoadedSessionView {
  const view = useSyncExternalStore(
    (listener) => {
      if (!sessionId) return () => {};
      const entry = cached(sessionId);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    () => sessionId ? cached(sessionId).view : EMPTY,
    () => EMPTY,
  );

  useEffect(() => {
    if (!sessionId) return;
    const entry = cached(sessionId);

    return onChat(sessionId, {
      // What the connection asks from when it is opened, or opened again after
      // a drop. Asking from zero would send the whole conversation a second
      // time, and fold it onto itself.
      since: () => entry.view.lastSeq,

      // The newest conversation window as the sidecar built it. Older windows
      // are fetched only when the reader reaches the top.
      snapshot: (data) => {
        try {
          // Filled against a blank chat rather than trusted: the sidecar is a
          // process that outlives this page, so it can be older than the screen
          // and simply not send a list the screen draws (bw-7ks.22.16).
          const opening = asView(JSON.parse(data) as Partial<SessionView>);
          if (opening.lastSeq >= entry.view.lastSeq) publishCached(sessionId, opening);
          // The snapshot is the newest server-built window. Loading farther
          // back here makes an opened chat grow through its older history
          // before the reader has asked for it, which reads as the transcript
          // replaying from the top. `DrawnTranscript` calls `loadOlder` only
          // after the reader reaches its head.
        } catch {
          // A frame this page cannot read leaves the transcript as it stands.
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
        if (event.seq > entry.view.lastSeq) publishCached(sessionId, reduce(entry.view, event));
      },
    });
  }, [sessionId]);

  const requestOlder = useCallback(
    () => sessionId ? loadHistory(sessionId) : Promise.resolve(),
    [sessionId],
  );
  return {
    ...view,
    loadOlder: sessionId && view.hasOlder && view.historyCursor !== null ? requestOlder : null,
  };
}

/** True while the agent owes an answer — the Stop button's condition. */
export function isBusy(state: SessionState): boolean {
  return state === 'thinking' || state === 'streaming' || state === 'running_tool' || state === 'waiting_permission';
}

/**
 * Which chat is open is not a state any component holds: it is in the address,
 * and the chat tab reads it there (docs/designs/app-shell.md §1.7). A hook that
 * kept its own copy answered the first link and then quietly disagreed with
 * every one after it — which is what made an open chat unlinkable and Back do
 * nothing (bw-m8o).
 */
