/**
 * What a project remembers is read when someone opens the panel that shows it.
 *
 * The panel is mounted beside the board, so the board used to pay for it: a
 * `bd memories` run of its own on every board open, a seventh of a second,
 * most often to be told the project remembers nothing (bw-uiyz.14).
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listMock = vi.fn();

vi.mock('@/lib/api', () => ({
  memory: {
    list: (...args: unknown[]) => listMock(...args),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

// Import AFTER the mock so the hook picks it up.
// eslint-disable-next-line import/first, import/order
import { useMemory } from '../use-memory';

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue([]);
});

describe('what a closed memory panel costs', () => {
  it('asks nothing while nobody is looking', () => {
    renderHook(() => useMemory('/p', false));
    expect(listMock).not.toHaveBeenCalled();
  });

  it('asks once the panel is opened', async () => {
    const { rerender } = renderHook(({ open }) => useMemory('/p', open), {
      initialProps: { open: false },
    });
    expect(listMock).not.toHaveBeenCalled();

    rerender({ open: true });

    await waitFor(() => expect(listMock).toHaveBeenCalledWith('/p'));
  });

  it('keeps reading on its own for anyone who does not say', async () => {
    renderHook(() => useMemory('/p'));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith('/p'));
  });
});
