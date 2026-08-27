import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WbpEvent } from '@/workbench/protocol';
import { EMPTY } from '@/workbench/fold';

let listener: { snapshot(data: string): void; event(data: string): void } | null = null;
vi.mock('@/workbench/live-wire', () => ({
  onChat: (_id: string, next: typeof listener) => { listener = next; return () => {}; },
}));
vi.mock('@/lib/api', () => ({ request: vi.fn() }));

import { cacheSessionEvent, useSession } from '@/workbench/use-session';

const opened = {
  ...EMPTY,
  items: [{ kind: 'message' as const, id: 'm1', role: 'assistant' as const, text: 'kept ready', images: [], status: 'done' as const }],
  lastSeq: 3,
};

describe('the browser session cache', () => {
  beforeEach(() => { listener = null; });

  it('reopens a chat from memory before any new snapshot arrives', () => {
    const first = renderHook(() => useSession('cache-reopen'));
    act(() => listener!.snapshot(JSON.stringify(opened)));
    expect(first.result.current.items[0]?.id).toBe('m1');
    first.unmount();

    const reopened = renderHook(() => useSession('cache-reopen'));
    expect(reopened.result.current.items[0]?.id).toBe('m1');
  });

  it('folds app-wide events into a chat while its pane is not mounted', () => {
    const first = renderHook(() => useSession('cache-background'));
    act(() => listener!.snapshot(JSON.stringify({ ...EMPTY, lastSeq: 1 })));
    first.unmount();

    act(() => cacheSessionEvent({
      type: 'message.started', sessionId: 'cache-background', seq: 2, at: '', messageId: 'm2', role: 'assistant',
    } as WbpEvent));
    const reopened = renderHook(() => useSession('cache-background'));
    expect(reopened.result.current.items.some((item) => item.id === 'm2')).toBe(true);
  });

  it('shows no row from the previous chat while the next snapshot is loading', () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useSession(id),
      { initialProps: { id: 'isolation-first' } },
    );
    act(() => listener!.snapshot(JSON.stringify({
      ...opened,
      items: [{ ...opened.items[0]!, text: 'belongs only to the first chat' }],
    })));
    expect(result.current.items[0]?.kind === 'message' && result.current.items[0].text).toBe(
      'belongs only to the first chat',
    );

    rerender({ id: 'isolation-second' });

    expect(result.current.items).toEqual([]);
  });
});
