/**
 * Reading a chat is not the chat doing something.
 *
 * Opening a conversation replays the whole of it onto the app's one live
 * stream, every message stamped with the moment it was read. The list took each
 * of those for activity, so reading a chat from March carried it to the top
 * under today's time — and the manager lost his place in the list every time he
 * looked at anything (bw-4wcd.9).
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asView, EMPTY, foldAll, reduce, type SessionView } from '@/workbench/fold';
import { movesTheClock } from '@/workbench/live';
import type { SessionState, WbpEvent } from '@/workbench/protocol';
import { useSession } from '@/workbench/use-session';

import { tagged } from './tagged';

describe('a chat’s own clock', () => {
  it('does not move for a chat that is asleep', () => {
    expect(movesTheClock('dormant')).toBe(false);
  });

  it('moves for every state that means the agent is at work', () => {
    const working: SessionState[] = ['starting', 'thinking', 'streaming', 'running_tool', 'idle'];
    for (const state of working) expect(movesTheClock(state)).toBe(true);
  });

  it('does not move for a chat nothing is known about', () => {
    expect(movesTheClock(undefined)).toBe(false);
  });
});

/**
 * What opening a chat costs, and what a dropped stream costs after it.
 *
 * A chat handed the browser every event ever recorded — three and three
 * quarter megabytes for the longest one on this machine, of which four
 * hundredths were still on the screen, the rest wiped by a later
 * `transcript.reset` — and the browser folded all of it, looking over every row
 * drawn for each event. The sidecar folds it once now and sends what it built;
 * a stream that drops asks for what has happened since rather than for the lot
 * again (bw-uiyz.4).
 */

/** One event without the envelope the wire wraps it in. */
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;

let stamped = 0;
function said(e: Said<WbpEvent>): WbpEvent {
  stamped += 1;
  return { ...e, seq: stamped, sessionId: 'chat-1', at: '2026-08-20T00:00:00.000Z' } as WbpEvent;
}

/** A turn of a conversation: a message, a command with its answer and its diff. */
function turn(n: number): WbpEvent[] {
  return [
    said({ type: 'message.started', messageId: `m${n}`, role: n % 2 ? 'assistant' : 'user' }),
    said({ type: 'text.delta', messageId: `m${n}`, text: `what was said ${n}` }),
    said({ type: 'text.delta', messageId: `m${n}`, text: ', and more of it' }),
    said({ type: 'thinking.delta', messageId: `m${n}`, text: 'working it out' }),
    said({ type: 'message.completed', messageId: `m${n}` }),
    said({
      type: 'tool.started',
      toolCallId: `t${n}`,
      name: 'Edit',
      input: { file_path: `a${n}.ts` },
      title: `Edit a${n}.ts`,
      parentToolCallId: null,
    }),
    said({ type: 'tool.progress', toolCallId: `t${n}`, seconds: 3 }),
    said({ type: 'diff', toolCallId: `t${n}`, path: `a${n}.ts`, before: 'let x = 1;', after: 'let x = 2;' }),
    said({ type: 'tool.completed', toolCallId: `t${n}`, ok: true, output: 'done' }),
  ];
}

/** Everything a conversation can hold, with a re-read of its past in the middle. */
function aWholeChat(turns: number): WbpEvent[] {
  const log: WbpEvent[] = [
    said({ type: 'session.started', brand: 'claude', externalId: null, model: 'opus', permissionMode: 'default', cwd: '/w' }),
    said({ type: 'session.menu', commands: [], skills: ['x'], models: [], permissionModes: ['default'], agentControls: ['stop', 'park', 'say'] }),
    ...turn(0),
    said({ type: 'note', noteId: 'n1', rank: 'note', kind: 'compact', text: 'compacted', body: null }),
    said({ type: 'link.bead', beadId: 'bw-uiyz', via: 'tool' }),
    said({ type: 'link.bead', beadId: 'bw-uiyz', via: 'tool' }),
    // Everything above is republished below: the record was read again.
    said({ type: 'transcript.reset' }),
  ];
  for (let i = 0; i < turns; i += 1) log.push(...turn(i));
  log.push(
    said({ type: 'notice', text: 'the agent stopped' }),
    said({ type: 'ask.permission', askId: 'a1', toolName: 'Bash', input: {}, title: 'rm -rf', options: [] }),
    said({ type: 'ask.resolved', askId: 'a1', chosen: 'no' }),
    said({ type: 'todo', items: [{ id: '1', text: 'one', status: 'pending' }] }),
    said({ type: 'cost', cost: { kind: 'usd', usd: 1.5 } }),
    said({ type: 'context', used: 10, window: 100 }),
    said({ type: 'thinking.progress', tokens: 44 }),
    said({ type: 'session.pinned', permissionMode: 'plan', model: null }),
    said({ type: 'session.state', state: 'idle', label: 'Idle' }),
    said({ type: 'link.bead', beadId: 'bw-2uh1', via: 'tool' }),
  );
  return log;
}

describe('building a conversation out of its log', () => {
  it('says exactly what folding it one event at a time says', () => {
    const log = aWholeChat(3);
    expect(foldAll(log)).toEqual(log.reduce(reduce, EMPTY));
  });

  it('keeps nothing from before the record was read again', () => {
    const view = foldAll(aWholeChat(2));
    // The turn published before the reset is gone, and its card with it.
    expect(view.items.filter((it) => it.kind === 'note')).toHaveLength(0);
    expect(view.beads).toEqual(['bw-2uh1']);
  });

  it('costs one look over the conversation, not one per event', () => {
    // Long enough that a look per event is a different shape of cost, not a
    // slower one: 600 turns is ~2,400 rows and ~5,400 events.
    const log = aWholeChat(600);
    const started = performance.now();
    const built = foldAll(log);
    const once = performance.now() - started;

    const startedAgain = performance.now();
    const byEvent = log.reduce(reduce, EMPTY);
    const perEvent = performance.now() - startedAgain;

    expect(built).toEqual(byEvent);
    // The true gap on this log is around a hundredfold; the bar is set low
    // enough that a busy machine cannot make it flap.
    expect(perEvent / Math.max(once, 0.01)).toBeGreaterThan(5);
  });
});

/** Every stream opened during a case, newest last. */
let opened: FakeStream[] = [];

/**
 * The browser's WebSocket, as much of it as the hook touches.
 *
 * Every feed a window watches arrives on its one connection, each frame naming
 * the feed it came from (live-wire.ts, bw-zkh4). The open chat's are `chat`
 * and `chat.snapshot`.
 */
class FakeStream {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    opened.push(this);
  }

  private owner(): string {
    return new URL(this.url).searchParams.get('chat') ?? '';
  }

  close(): void {
    this.closed = true;
  }

  /**
   * The sidecar hands over the conversation as it stands.
   *
   * Loosely typed on purpose: an older sidecar hands over a shape that no
   * longer matches, and refusing to say so in a test would only prove the
   * screen copes with the shape it wrote itself.
   */
  hands(view: SessionView | Record<string, unknown>): void {
    this.onmessage?.(tagged('chat.snapshot', JSON.stringify(view), this.owner()));
  }

  /** One event arriving live, after the conversation was drawn. */
  says(e: WbpEvent): void {
    this.onmessage?.(tagged('chat', JSON.stringify(e), this.owner()));
  }

  dies(): void {
    this.onerror?.();
  }
}

describe('a chat opened, and opened again after the stream drops', () => {
  beforeEach(() => {
    opened = [];
    stamped = 0;
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeStream);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks for the conversation once and draws what it is handed', () => {
    const { result } = renderHook(() => useSession('chat-1'));
    expect(opened).toHaveLength(1);
    expect(opened[0].url).toContain('since=0');

    const built = foldAll(aWholeChat(2));
    act(() => opened[0].hands(built));

    expect(result.current.items).toHaveLength(built.items.length);
    expect(result.current.lastSeq).toBe(built.lastSeq);
  });

  it('leaves older history unread until the reader reaches the transcript head', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    renderHook(() => useSession('chat-1'));

    const built = foldAll(aWholeChat(2));
    act(() => opened[0].hands({ ...built, hasOlder: true, historyCursor: 42 }));

    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads exactly one cursor page per request and suppresses an overlapping request', async () => {
    let answer!: (value: unknown) => void;
    const response = new Promise((resolve) => { answer = resolve; });
    const fetch = vi.fn((_input: RequestInfo | URL) => response);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useSession('paged-chat'));

    const built = foldAll(aWholeChat(2));
    act(() => opened[0].hands({ ...built, hasOlder: true, historyCursor: 42 }));
    const older = foldAll(turn(99)).items;

    let first!: Promise<void>;
    act(() => {
      first = result.current.loadOlder!();
      void result.current.loadOlder!();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toContain('before=42');

    answer({ ok: true, json: async () => ({ items: older, cursor: 21, hasOlder: true }) });
    await act(async () => { await first; });

    expect(result.current.historyCursor).toBe(21);
    expect(result.current.hasOlder).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops at a cursor that does not advance instead of replaying it forever', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], cursor: 42, hasOlder: true }),
    });
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useSession('stuck-page-chat'));
    const built = foldAll(aWholeChat(2));
    act(() => opened[0].hands({ ...built, hasOlder: true, historyCursor: 42 }));

    await act(async () => { await result.current.loadOlder!(); });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.hasOlder).toBe(false);
    expect(result.current.loadOlder).toBeNull();
  });

  it('asks only for what arrived since, when the stream comes back', () => {
    const { result } = renderHook(() => useSession('chat-1'));
    const built = foldAll(aWholeChat(2));
    act(() => opened[0].hands(built));
    const drawn = result.current.items.length;

    act(() => opened[0].dies());
    act(() => void vi.advanceTimersByTime(2_000));

    expect(opened).toHaveLength(2);
    expect(opened[1].url).toContain(`since=${built.lastSeq}`);
    // What was already drawn is still there: it was not asked for again.
    expect(result.current.items).toHaveLength(drawn);

    stamped = built.lastSeq;
    act(() => opened[1].says(said({ type: 'notice', text: 'back' })));
    expect(result.current.items).toHaveLength(drawn + 1);
  });

  it('leaves nothing open behind it', () => {
    const { unmount } = renderHook(() => useSession('chat-1'));
    unmount();
    expect(opened[0].closed).toBe(true);
    act(() => void vi.advanceTimersByTime(5_000));
    expect(opened).toHaveLength(1);
  });
});

/**
 * A sidecar older than the screen.
 *
 * The sidecar is a process and the screen is a page. The page reloads into new
 * code in a second; the process goes on running the code it was started with
 * until somebody restarts it — which is every upgrade, and was every one of
 * this job's own runs. A screen that reads a list off that conversation read
 * nothing at all and took the whole chat down with it: "can't access property
 * length, agents is undefined", measured 2026-08-20 against a sidecar started
 * before the panel existed.
 */
describe('a conversation handed over by an older sidecar', () => {
  const sessionId = 'chat-from-older-sidecar';
  beforeEach(() => {
    opened = [];
    stamped = 0;
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeStream);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The conversation as a sidecar that has never heard of sent-off work sends it. */
  function anOlderChat(): Record<string, unknown> {
    const { agents, todos, menu, ...rest } = foldAll(aWholeChat(2));
    return { ...rest, menu: { commands: [], skills: [] } };
  }

  it('draws it, with nothing where the lists it never sent would be', () => {
    const { result } = renderHook(() => useSession(sessionId));
    const older = anOlderChat();
    act(() => opened[0].hands(older));

    // The conversation itself is all there — this is not a screen that gave up.
    expect(result.current.items).toHaveLength((older.items as unknown[]).length);
    expect(result.current.lastSeq).toBe(older.lastSeq);

    // And every list the screen draws is a list, so drawing it is a no-op
    // rather than a crash.
    expect(result.current.agents).toEqual([]);
    expect(result.current.todos).toEqual([]);
    expect(result.current.menu.models).toEqual([]);
    expect(result.current.menu.permissionModes).toEqual([]);
  });

  it('still folds what arrives live on top of it', () => {
    const { result } = renderHook(() => useSession(sessionId));
    const older = anOlderChat();
    act(() => opened[0].hands(older));
    const drawn = result.current.items.length;

    act(() =>
      opened[0].says({
        type: 'agent.started',
        seq: (older.lastSeq as number) + 1,
        sessionId,
        at: '2026-08-20T00:00:01.000Z',
        agentId: 'a1',
        toolCallId: null,
        kind: 'helper',
        what: 'check the login code',
        agentType: null,
        model: null,
      }),
    );

    expect(result.current.items).toHaveLength(drawn);
    expect(result.current.agents).toHaveLength(1);
  });

  it('fills a chat handed over as nothing at all', () => {
    // Whatever the far end sends, the screen holds a whole chat: a null, an
    // empty object, a list where an object belongs, an object where a list
    // belongs. Every list of the menu, not only the ones that came first —
    // guarding the old fields and not the new one guards exactly the fields
    // that were never going to be missing (bw-7ks.22.31).
    const bad = [null, undefined, {}, { agents: null }, { menu: null }, { menu: { agentControls: null } }, { menu: { agentControls: 'stop' } }];
    for (const sent of bad) {
      const view = asView(sent as never);
      expect(Array.isArray(view.agents)).toBe(true);
      expect(Array.isArray(view.items)).toBe(true);
      expect(Array.isArray(view.menu.commands)).toBe(true);
      expect(Array.isArray(view.menu.agentControls)).toBe(true);
      expect(view.state).toBe(EMPTY.state);
    }
  });

  it('takes a menu from a sidecar that has never heard of steering controls', () => {
    // The menu the sidecar announces is the menu the code it was started with
    // knew about. Both ways of building a chat have to survive it, or the panel
    // asks a list that is not there whether it contains `stop`.
    stamped = 0;
    const older = said({ type: 'session.menu', commands: [], skills: [], models: [], permissionModes: ['default'] } as never);

    expect(reduce(EMPTY, older).menu.agentControls).toEqual([]);
    expect(foldAll([older]).menu.agentControls).toEqual([]);
    // And what it did send is still there.
    expect(foldAll([older]).menu.permissionModes).toEqual(['default']);
  });

  it('keeps what the sidecar did send', () => {
    const view = asView({ agents: [], state: 'thinking', stateLabel: 'Thinking', lastSeq: 9 });
    expect(view.state).toBe('thinking');
    expect(view.lastSeq).toBe(9);
  });
});
