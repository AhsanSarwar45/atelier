/**
 * What one keystroke costs.
 *
 * Every row of a chat is remembered against its own message, so typing should
 * cost one box redrawn and nothing else. It cost the whole conversation: what
 * the chat knows about disk was built fresh on every pass, the chat's list of
 * what may be clicked is built from it, and that list is handed to every
 * message — so a new one is a new prop on all of them, and React's remembering
 * is defeated on the way in. Two thousand messages had their markdown parsed
 * again for each character, at two and a half seconds a keystroke (bw-2lzj.1).
 *
 * The browser-side measurement is `scripts/chat-typing-cost.mjs`; this holds
 * the one value that has to keep its identity for that measurement to stay
 * true.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  fs: {
    exists: () => Promise.resolve({ exists: false }),
    roots: () => Promise.resolve({ home: '/home/someone', roots: [] }),
  },
}));

import { forgetDisk, usePathsOnDisk } from '@/workbench/paths-on-disk';

beforeEach(() => {
  forgetDisk();
});

describe('what a chat knows about disk', () => {
  it('is one value, not a new one on every pass', () => {
    const { result, rerender } = renderHook(() => usePathsOnDisk());
    const first = result.current;

    // A keystroke: the chat around the conversation is drawn again, with
    // nothing about disk changed.
    rerender();
    rerender();

    expect(result.current).toBe(first);
  });

  it('is a new value when the answer changed', async () => {
    const { result } = renderHook(() => usePathsOnDisk());
    const before = result.current;

    // The reader's home arrives from the server after the first draw, and what
    // a name written with `~` means depends on it.
    await waitFor(() => expect(result.current.home).toBe('/home/someone'));

    expect(result.current).not.toBe(before);
  });
});
