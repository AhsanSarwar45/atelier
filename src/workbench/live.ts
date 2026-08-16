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

import { useSyncExternalStore } from 'react';

import { apiUrl } from '@/lib/api-base';
import type { Brand, SessionState, SessionSummary, WatchFrame } from '@/workbench/protocol';

/** What one chat is doing, as every global view needs it. */
export interface LiveSession {
  id: string;
  brand: Brand;
  projectId: string;
  projectPath: string;
  title: string | null;
  state: SessionState;
  /** The agent's own words for what it is doing — "Asking about Edit", "Answering". */
  activity: string;
  /** What it is waiting for, when it is waiting on the owner. */
  waitingFor: string | null;
  lastActiveAt: string;
  startedAt: string;
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

const listeners = new Set<() => void>();
let sessions: LiveSession[] = [];
let source: EventSource | null = null;
/** Rebuilt on every change so `useSyncExternalStore` sees a new reference. */
let snapshot: LiveSession[] = sessions;

function announce(): void {
  snapshot = sessions;
  listeners.forEach((fn) => fn());
}

function fromSummary(s: SessionSummary & { activity: string }): LiveSession {
  return {
    id: s.id,
    brand: s.brand,
    projectId: s.projectId,
    projectPath: s.projectPath,
    title: s.title,
    state: s.state,
    activity: s.activity,
    waitingFor: null,
    lastActiveAt: s.lastActiveAt,
    startedAt: s.createdAt,
  };
}

function patch(id: string, change: Partial<LiveSession>): void {
  const at = sessions.findIndex((s) => s.id === id);
  if (at < 0) return;
  sessions = sessions.map((s, i) => (i === at ? { ...s, ...change } : s));
}

function absorb(frame: WatchFrame): void {
  if (frame.kind === 'snapshot') {
    sessions = frame.sessions.map(fromSummary);
    announce();
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
        projectId: '',
        projectPath: e.cwd,
        title: null,
        state: 'starting',
        activity: '',
        waitingFor: null,
        lastActiveAt: e.at,
        startedAt: e.at,
      },
    ];
  }

  switch (e.type) {
    case 'session.state':
      patch(e.sessionId, { state: e.state, activity: e.label, lastActiveAt: e.at });
      break;
    case 'ask.permission':
      patch(e.sessionId, { waitingFor: e.title, lastActiveAt: e.at });
      break;
    case 'ask.resolved':
      patch(e.sessionId, { waitingFor: null, lastActiveAt: e.at });
      break;
    case 'text.delta':
      patch(e.sessionId, { lastActiveAt: e.at });
      break;
    case 'error':
      patch(e.sessionId, { waitingFor: e.message, lastActiveAt: e.at });
      break;
    default:
      return;
  }
  announce();
}

function connect(): void {
  if (source) return;
  source = new EventSource(apiUrl('/api/workbench/watch'));
  source.onmessage = (msg) => absorb(JSON.parse(msg.data) as WatchFrame);
  // The workbench may not be running at all; the board half of the app is
  // unaffected by that and must not be broken by a retry loop.
  source.onerror = () => {
    source?.close();
    source = null;
  };
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      source?.close();
      source = null;
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
