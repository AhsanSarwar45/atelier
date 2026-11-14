/**
 * The RAM and Guidance chips open the same panel as the usage, token and
 * worktree chips: the whole screen on a phone, with a Close button to get
 * back, rather than a small popup sized for a desktop.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActiveGuidance } from '@/workbench/active-guidance';
import { MemoryBadge } from '@/workbench/memory-badge';

const request = vi.fn();
vi.mock('@/lib/api', () => ({ request: (...args: unknown[]) => request(...args) }));

beforeEach(() => {
  request.mockResolvedValue({ ok: true, json: async () => ({
    totalBytes: 200 * 1024 ** 2, swapBytes: 0, metric: 'heldPssWithSwap', processCount: 1, chats: [],
    processDetails: [
      { pid: 10, parentPid: null, name: 'atelier', bytes: 100, swapBytes: 0, sessionId: null, chatTitle: null, role: 'app', killable: false, startTime: 1 },
    ],
  }) });
});
afterEach(() => vi.clearAllMocks());

describe('chip panels', () => {
  it('opens RAM usage in the full panel, closed by its Close button', async () => {
    render(<MemoryBadge />);
    fireEvent.click(await screen.findByTestId('memory-badge'));
    const panel = await screen.findByTestId('memory-popup');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('memory-popup')).toBeNull());
  });

  it('opens Active guidance in the full panel, closed by its Close button', async () => {
    render(<ActiveGuidance snapshot={{ revision: 'r1', items: [
      { id: 'rules', name: 'Team rules', kind: 'instruction', source: 'global', state: 'available' },
    ] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Active guidance' }));
    const panel = await screen.findByTestId('guidance-popover');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('guidance-popover')).toBeNull());
  });
});
