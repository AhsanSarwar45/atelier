/**
 * What moves a chat's own clock on the live stream, and what does not.
 *
 * The complaint: "the ordering of the chats must be the last time the USER
 * sent a message, so they don't keep jumping around as agents message". The
 * order is one clock (protocol.ts, whenHeSpoke) and this is the half of it
 * that moves while the manager watches — so the rule has to hold event by
 * event, not just when the list is fetched (bw-zhs9).
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionState, WatchFrame } from '@/workbench/protocol';

/** Every stream opened during a case, newest last. */
let opened: FakeStream[] = [];

class FakeStream {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    opened.push(this);
  }

  close(): void {
    this.closed = true;
  }

  /**
   * Every feed a window watches now arrives on its one connection, each frame
   * tagged with the feed it came from (live-wire.ts, bw-zkh4). The helper's
   * frames are tagged `workbench`, and that is the one this fake carries.
   */
  addEventListener(tag: string, listener: (e: { data: string }) => void): void {
    if (tag === 'workbench') this.onmessage = listener;
  }

  says(frame: WatchFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const SPOKE = '2026-08-19T09:00:00.000Z';
const LATER = '2026-08-19T11:00:00.000Z';

function summary(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    brand: 'claude' as const,
    externalId: 'x1',
    projectId: 'p1',
    projectPath: '/home/me/project',
    cwd: '/home/me/project',
    model: null,
    permissionMode: 'default',
    title: 'A chat',
    state: 'streaming' as SessionState,
    createdAt: SPOKE,
    lastActiveAt: SPOKE,
    lastSpokeAt: SPOKE,
    activity: 'Answering',
    beads: [],
    ...over,
  };
}

/** One event on the shared stream, as the sidecar sends it. */
function event(type: string, over: Record<string, unknown> = {}): WatchFrame {
  return {
    kind: 'event',
    event: { seq: 1, sessionId: 's1', at: LATER, type, ...over },
  } as WatchFrame;
}

async function freshModule() {
  vi.resetModules();
  return import('@/workbench/live');
}

beforeEach(() => {
  opened = [];
  vi.stubGlobal('EventSource', FakeStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what moves the clock the chat list is ordered by', () => {
  it('nothing the agent does: its reply, its thinking, its question, its card', async () => {
    const { useLiveSessions } = await freshModule();
    const { result } = renderHook(() => useLiveSessions());
    act(() => opened[0].says({ kind: 'snapshot', sessions: [summary()] } as WatchFrame));

    for (const frame of [
      event('message.started', { messageId: 'm1', role: 'assistant' }),
      event('text.delta', { messageId: 'm1', text: 'working on it' }),
      event('thinking.delta', { messageId: 'm1', text: 'hmm' }),
      event('ask.permission', { askId: 'a1', title: 'Edit chat-sidebar.tsx', options: [] }),
      event('ask.resolved', { askId: 'a1', optionId: 'allow' }),
      event('link.bead', { beadId: 'bw-zhs9' }),
    ]) {
      act(() => opened[0].says(frame));
    }

    expect(result.current[0]!.lastSpokeAt, 'an agent working moved the list').toBe(SPOKE);
    // What happened last did move — that clock is still the truth about the
    // chat, it is simply not what the list is ordered by.
    expect(result.current[0]!.lastActiveAt).toBe(LATER);
  });

  it('a message he sends does', async () => {
    const { useLiveSessions } = await freshModule();
    const { result } = renderHook(() => useLiveSessions());
    act(() => opened[0].says({ kind: 'snapshot', sessions: [summary()] } as WatchFrame));

    act(() => opened[0].says(event('message.started', { messageId: 'm2', role: 'user' })));
    expect(result.current[0]!.lastSpokeAt).toBe(LATER);
  });

  it('reading an old chat does not, however much of it replays', async () => {
    // Opening a conversation says the whole of it onto this stream, his own
    // messages included, each stamped with the moment it was read. A sleeping
    // chat did nothing (live.ts, movesTheClock; bw-4wcd.9).
    const { useLiveSessions } = await freshModule();
    const { result } = renderHook(() => useLiveSessions());
    act(() => opened[0].says({ kind: 'snapshot', sessions: [summary({ state: 'dormant' })] } as WatchFrame));

    act(() => opened[0].says(event('message.started', { messageId: 'm3', role: 'user' })));
    expect(result.current[0]!.lastSpokeAt, 'reading a chat carried it to the top').toBe(SPOKE);
    expect(result.current[0]!.lastActiveAt).toBe(SPOKE);
  });

  it('a chat he has never sent into carries no clock of its own', async () => {
    const { useLiveSessions } = await freshModule();
    const { result } = renderHook(() => useLiveSessions());
    act(() => opened[0].says({ kind: 'snapshot', sessions: [summary({ lastSpokeAt: null })] } as WatchFrame));

    expect(result.current[0]!.lastSpokeAt, 'silence was written down as a time').toBeNull();
  });
});
