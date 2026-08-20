/**
 * The list of a project's agent files is read when someone opens the panel
 * that shows it.
 *
 * The panel is mounted beside the board, so the board paid for it: a third of
 * a second on every board open, for a list nobody had asked to see
 * (bw-uiyz.16).
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listMock = vi.fn();

vi.mock('@/lib/api', () => ({
  agents: {
    list: (...args: unknown[]) => listMock(...args),
    update: vi.fn(),
  },
}));

// Import AFTER the mock so the hook picks it up.
// eslint-disable-next-line import/first, import/order
import { useAgents } from '../use-agents';

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue([]);
});

describe('what a closed agents panel costs', () => {
  it('asks nothing while nobody is looking', () => {
    renderHook(() => useAgents('/p', false));
    expect(listMock).not.toHaveBeenCalled();
  });

  it('asks once the panel is opened', async () => {
    const { rerender } = renderHook(({ open }) => useAgents('/p', open), {
      initialProps: { open: false },
    });
    expect(listMock).not.toHaveBeenCalled();

    rerender({ open: true });

    await waitFor(() => expect(listMock).toHaveBeenCalledWith('/p'));
  });

  it('keeps reading on its own for anyone who does not say', async () => {
    renderHook(() => useAgents('/p'));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith('/p'));
  });
});
