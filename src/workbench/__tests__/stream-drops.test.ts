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

/** Every stream opened during a case, newest last. */
let opened: FakeStream[] = [];

/** The browser's EventSource, as much of it as this module touches. */
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

  /** The sidecar says which conversations a live process is holding. */
  says(conversations: string[]): void {
    this.onmessage?.({ data: JSON.stringify({ kind: 'running', conversations }) });
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
  vi.stubGlobal('EventSource', FakeStream);
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
});
