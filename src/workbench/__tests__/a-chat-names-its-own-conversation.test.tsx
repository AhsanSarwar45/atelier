/**
 * Which provider conversation an open chat names.
 *
 * The complaint behind it: a chat whose profile was switched went on naming
 * the conversation it had let go. The live store said `null`, a read of the
 * chat's facts kept for the life of the page still named the old one, and the
 * writing box took the old one — to decide who holds the chat and whether it
 * may send (bw-ljko.3).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { conversationOf } from '@/workbench/running';

const request = vi.fn();
vi.mock('@/lib/api', async (real) => ({
  ...(await real<typeof import('@/lib/api')>()),
  request: (path: string) => request(path),
}));

function answer(externalId: string | null) {
  return { ok: true, json: async () => ({ id: 's1', brand: 'claude', externalId }) };
}

afterEach(() => {
  request.mockReset();
});

describe('the conversation a chat runs on', () => {
  it('is what the live store says while it holds the chat, a let-go conversation included', () => {
    expect(conversationOf({ externalId: null }, { externalId: 'old' })).toBeNull();
    expect(conversationOf({ externalId: 'new' }, { externalId: 'old' })).toBe('new');
  });

  it('is what the facts say only before the stream has named the chat', () => {
    expect(conversationOf(undefined, { externalId: 'old' })).toBe('old');
    expect(conversationOf(undefined, null)).toBeNull();
  });
});

describe('the facts of a chat opened again', () => {
  it('are drawn from the last read at once, then read again', async () => {
    const { useSessionFactsRead } = await import('@/workbench/use-session');
    request.mockResolvedValueOnce(answer('old'));
    const first = renderHook(({ id }) => useSessionFactsRead(id), { initialProps: { id: 's1' as string | null } });
    await waitFor(() => expect(first.result.current?.facts.externalId).toBe('old'));
    first.unmount();

    // The profile was switched while the chat was closed.
    let settle!: (value: unknown) => void;
    request.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const again = renderHook(({ id }) => useSessionFactsRead(id), { initialProps: { id: 's1' as string | null } });
    expect(again.result.current?.facts.externalId, 'nothing was drawn while it was read').toBe('old');
    expect(request).toHaveBeenCalledTimes(2);

    await act(async () => settle(answer(null)));
    expect(again.result.current?.facts.externalId, 'the first read was kept for good').toBeNull();
  });
});
