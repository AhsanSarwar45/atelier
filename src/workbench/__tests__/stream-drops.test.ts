/**
 * What the screen knows about who is working, after the stream stops speaking.
 *
 * The complaint: with the shared status stream dead — the browser console said
 * net::ERR_INCOMPLETE_CHUNKED_ENCODING — a chat the server itself reported as
 * being worked in opened with an ordinary writing box, and typing into it would
 * have started a second agent on somebody else's conversation. The stream never
 * came back either, so it stayed that way until the page was reloaded
 * (bw-dmxj.12).
 *
 * Two things had to change and both are here: what the stream said last is
 * dropped rather than kept as an answer, and the connection is made again.
 * The door itself is the server's (workbench/src/sessions.ts, HELD_ELSEWHERE) —
 * this is the screen no longer claiming to know something it does not.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tagged } from './tagged';

/** Every stream opened during a case, newest last. */
let opened: FakeStream[] = [];

/** The browser's WebSocket, as much of it as this module touches. */
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


  /** The sidecar says which conversations a live process is holding, and what each is doing. */
  says(conversations: string[]): void {
    const holds = conversations.map((id) => ({ id, holder: 'terminal', doing: 'unknown', since: null }));
    this.onmessage?.(tagged('workbench', JSON.stringify({ kind: 'running', holds })));
  }

  /** The connection dies the way it died on the manager's machine. */
  dies(): void {
    this.onerror?.();
  }
}

async function freshModule() {
  vi.resetModules();
  return import('@/workbench/live');
}

beforeEach(() => {
  opened = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeStream);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('when the live stream drops', () => {
  it('stops claiming to know who is working, and connects again', async () => {
    const { useRunningElsewhere } = await freshModule();
    const { result } = renderHook(() => useRunningElsewhere());

    expect(opened.length, 'no stream was opened').toBe(1);
    act(() => opened[0].says(['held-by-somebody-else']));
    expect(result.current?.has('held-by-somebody-else')).toBe(true);

    // The stream dies. What it said is now a memory, not an answer: a chat that
    // started being worked in after this would be missing from it, and the
    // writing box reads it to decide whether to lock.
    act(() => opened[0].dies());
    expect(result.current, 'the screen kept a dead stream’s answer').toBeNull();
    expect(opened[0].closed).toBe(true);

    // And it comes back on its own, rather than waiting for a page reload.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(opened.length, 'the stream was never re-opened').toBe(2);

    act(() => opened[1].says(['held-by-somebody-else']));
    expect(result.current?.has('held-by-somebody-else')).toBe(true);
  });

  it('waits longer each time while nothing is listening at the other end', async () => {
    const { useRunningElsewhere } = await freshModule();
    renderHook(() => useRunningElsewhere());

    act(() => opened[0].dies());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(opened.length).toBe(2);

    // The second attempt dies too, so the third waits twice as long: a sidecar
    // that is not running must not be hammered by the board half of the app.
    act(() => opened[1].dies());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(opened.length, 'it retried on the short wait twice running').toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(opened.length).toBe(3);
  });

  it('stops saying what each held chat is doing, rather than freezing on the last word', async () => {
    const { useHolds } = await freshModule();
    const { result } = renderHook(() => useHolds());

    act(() => opened[0].says(['held-by-somebody-else']));
    expect(result.current?.get('held-by-somebody-else')?.holder).toBe('terminal');

    // The sibling of the set above, and the half that goes stale where it can
    // be seen: the open chat draws this straight, so a dead connection used to
    // leave the moving mark turning and its seconds climbing on whatever was
    // said last — through up to half a minute of retrying, and identical on
    // screen to a chat really being worked in (bw-96is.22).
    act(() => opened[0].dies());
    expect(result.current, 'the screen went on drawing a dead stream’s last word').toBeNull();

    // And it is known again as soon as anybody is speaking.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    act(() => opened[1].says(['held-by-somebody-else']));
    expect(result.current?.get('held-by-somebody-else')?.holder).toBe('terminal');
  });

  it('tells a silence nobody has spoken into from one that follows an answer', async () => {
    // Both leave the screens with null in their hands, and they are opposite
    // situations. Before anybody has spoken, what a screen fetched for itself
    // is the freshest thing there is and it draws it. After the stream has
    // spoken and gone away, that same fetch is older than what was just thrown
    // out — the open chat's facts date from when the pane was opened, a row's
    // from when the list was drawn — so drawing it restarts a mark and counts
    // its seconds from a moment long gone (bw-96is.22).
    const { useHeldFactsAreOld } = await freshModule();
    const { result } = renderHook(() => useHeldFactsAreOld());
    expect(result.current, 'a page accused its own facts before the stream had said a word').toBe(false);

    act(() => opened[0].says(['held-by-somebody-else']));
    expect(result.current, 'the facts were called old while the stream was speaking').toBe(false);

    act(() => opened[0].dies());
    expect(result.current, 'the screens went on drawing what they were given at build time').toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    act(() => opened[1].says([]));
    expect(result.current, 'the accusation outlived the stream coming back').toBe(false);
  });

  it('goes on waiting while screens come and go, rather than starting the count again', async () => {
    // Moving around the app while the server is down is the ordinary case — a
    // project is opened, a chat is closed — and each of those mounts or
    // unmounts a watcher. The wait to the next attempt used to be thrown away
    // and the connection reopened on the spot every time one did, so navigating
    // during an outage hammered a door nobody was behind and the backing-off
    // never actually happened (bw-zkh4.9).
    const { useRunningElsewhere } = await freshModule();
    const { onBoard } = await import('@/workbench/live-wire');
    renderHook(() => useRunningElsewhere());

    act(() => opened[0].dies());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(opened.length).toBe(2);

    // That attempt fails too, so the next one is four seconds away.
    act(() => opened[1].dies());

    // A card list is drawn, which is what opening a project does.
    const stopWatchingTheBoard = onBoard('/somewhere/a-project', () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(opened.length, 'a screen mounting reopened it on the spot').toBe(2);

    stopWatchingTheBoard();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(opened.length, 'the wait was put back to its floor').toBe(2);

    // And the wait it was already keeping still runs out on its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(opened.length).toBe(3);
  });
});
