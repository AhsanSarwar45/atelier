import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryBadge, memoryWords } from '@/workbench/memory-badge';

const request = vi.fn();
vi.mock('@/lib/api', () => ({ request: (...args: unknown[]) => request(...args) }));

describe('memory badge', () => {
  beforeEach(() => {
    request.mockResolvedValue({ ok: true, json: async () => ({
      totalBytes: 200 * 1024 ** 2, metric: 'pss', processCount: 3,
      chats: [{ sessionId: 'chat-1', title: 'Build the app', bytes: 100, processes: 2 }],
      processDetails: [
        { pid: 10, parentPid: null, name: 'atelier', bytes: 100, sessionId: null, chatTitle: null, role: 'app', killable: false, startTime: 1 },
        { pid: 11, parentPid: 10, name: 'claude', bytes: 100, sessionId: null, chatTitle: null, role: 'accountReader', killable: false, startTime: 2 },
        { pid: 14, parentPid: 13, name: 'cargo', bytes: 100, sessionId: 'chat-1', chatTitle: 'Build the app', role: 'subprocess', killable: true, startTime: 4 },
      ],
    }) });
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('uses compact binary units', () => {
    expect(memoryWords(512 * 1024 ** 2)).toBe('512 MB');
    expect(memoryWords(1536 * 1024 ** 2)).toBe('1.5 GB');
  });

  it('offers a confirmed stop only for a chat subprocess', async () => {
    render(<MemoryBadge />);
    fireEvent.click(await screen.findByTestId('memory-badge'));
    const stop = await screen.findByLabelText('Stop cargo');
    expect(screen.queryByLabelText('Stop atelier')).toBeNull();
    expect(screen.queryByLabelText('Stop claude')).toBeNull();
    fireEvent.click(stop);
    fireEvent.click(screen.getByLabelText('Confirm stopping cargo'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/workbench/memory/terminate', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ pid: 14, startTime: 4, sessionId: 'chat-1' }),
    })));
  });
});
