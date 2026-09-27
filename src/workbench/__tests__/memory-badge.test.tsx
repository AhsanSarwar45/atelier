import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryBadge, memoryGroups, memoryWords } from '@/workbench/memory-badge';

const request = vi.fn();
vi.mock('@/lib/api', () => ({ request: (...args: unknown[]) => request(...args) }));

describe('memory badge', () => {
  beforeEach(() => {
    request.mockResolvedValue({ ok: true, json: async () => ({
      totalBytes: 200 * 1024 ** 2, swapBytes: 50 * 1024 ** 2, metric: 'pssWithSwap', processCount: 3,
      chats: [{ sessionId: 'chat-1', title: 'Build the app', bytes: 100, processes: 2 }],
      processDetails: [
        { pid: 10, parentPid: null, name: 'atelier', bytes: 100, swapBytes: 0, sessionId: null, chatTitle: null, role: 'app', killable: false, startTime: 1 },
        { pid: 11, parentPid: 10, name: 'claude', bytes: 100, swapBytes: 20, sessionId: null, chatTitle: null, role: 'accountReader', killable: false, startTime: 2 },
        { pid: 14, parentPid: 13, name: 'cargo', bytes: 100, swapBytes: 0, sessionId: 'chat-1', chatTitle: 'Build the app', role: 'subprocess', killable: true, startTime: 4 },
      ],
    }) });
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('uses compact binary units', () => {
    expect(memoryWords(512 * 1024 ** 2)).toBe('512 MB');
    expect(memoryWords(1536 * 1024 ** 2)).toBe('1.5 GB');
  });

  // The chip's number counts swapped pages, so it can run well ahead of the
  // resident figure a system monitor reports. The popover has to say why.
  it('shows the total the app costs and splits it into resident and swapped', async () => {
    render(<MemoryBadge />);
    expect(await screen.findByTestId('memory-badge')).toHaveTextContent('200 MB');
    fireEvent.click(screen.getByTestId('memory-badge'));
    const split = await screen.findByTestId('memory-swap-line');
    expect(split).toHaveTextContent('In RAM 150 MB');
    expect(split).toHaveTextContent('Swapped 50 MB');
  });

  it('leaves the split out when nothing is paged out', async () => {
    request.mockResolvedValue({ ok: true, json: async () => ({
      totalBytes: 200 * 1024 ** 2, swapBytes: 0, metric: 'pssWithSwap', processCount: 1,
      chats: [], processDetails: [
        { pid: 10, parentPid: null, name: 'atelier', bytes: 100, swapBytes: 0, sessionId: null, chatTitle: null, role: 'app', killable: false, startTime: 1 },
      ],
    }) });
    render(<MemoryBadge />);
    fireEvent.click(await screen.findByTestId('memory-badge'));
    await screen.findByTestId('memory-popup');
    expect(screen.queryByTestId('memory-swap-line')).toBeNull();
  });

  // A monitor reading the service's control group sees file cache the chip's
  // per-process total leaves out; the popover names both and the pressure the
  // kernel's killer acts on (bw-ifjt.3).
  it('shows the service total, its freeable cache and the memory pressure', async () => {
    request.mockResolvedValue({ ok: true, json: async () => ({
      totalBytes: 2 * 1024 ** 3, swapBytes: 0, metric: 'pssWithSwap', processCount: 1,
      chats: [], processDetails: [],
      service: { totalBytes: 9 * 1024 ** 3, cacheBytes: 6 * 1024 ** 3, pressure: 77.2 },
    }) });
    render(<MemoryBadge />);
    fireEvent.click(await screen.findByTestId('memory-badge'));
    const service = await screen.findByTestId('memory-service');
    expect(service).toHaveTextContent('Service total9.0 GB');
    expect(service).toHaveTextContent('Freeable cache6.0 GB');
    expect(screen.getByTestId('memory-pressure')).toHaveTextContent('Memory pressure77%');
    expect(screen.getByTestId('memory-pressure')).toHaveClass('text-destructive');
  });

  it('leaves the service lines out when the app has no group of its own', async () => {
    render(<MemoryBadge />);
    fireEvent.click(await screen.findByTestId('memory-badge'));
    await screen.findByTestId('memory-popup');
    expect(screen.queryByTestId('memory-service')).toBeNull();
  });

  it('offers a confirmed stop only for a chat subprocess', async () => {
    render(<MemoryBadge />);
    fireEvent.click(await screen.findByTestId('memory-badge'));
    fireEvent.click(await screen.findByRole('button', { name: /Build the app/ }));
    fireEvent.click(screen.getByRole('button', { name: /^App/ }));
    const stop = await screen.findByLabelText('Stop cargo');
    expect(screen.queryByLabelText('Stop atelier')).toBeNull();
    expect(screen.queryByLabelText('Stop claude')).toBeNull();
    fireEvent.click(stop);
    fireEvent.click(screen.getByLabelText('Confirm stopping cargo'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/workbench/memory/terminate', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ pid: 14, startTime: 4, sessionId: 'chat-1' }),
    })));
  });

  // Containers are started by Docker, not by the chat's own processes, so
  // they are measured apart; the chip counts the ones a chat started and
  // lists the rest without charging Atelier for them (bw-meh1.2).
  it('charges a chat for the containers it started and lists the rest as nobody\'s', async () => {
    request.mockResolvedValue({ ok: true, json: async () => ({
      totalBytes: 1024 ** 3, swapBytes: 0, metric: 'pssWithSwap', processCount: 1,
      chats: [{ sessionId: 'chat-1', title: 'Build the app', bytes: 512 * 1024 ** 2, processes: 1, containerBytes: 2 * 1024 ** 3, containers: 1 }],
      processDetails: [
        { pid: 14, parentPid: 13, name: 'cargo', bytes: 512 * 1024 ** 2, swapBytes: 0, sessionId: 'chat-1', chatTitle: 'Build the app', role: 'subprocess', killable: true, startTime: 4 },
      ],
      containerBytes: 3 * 1024 ** 3,
      containers: [
        { id: 'a', name: 'shop-web', image: 'shop', bytes: 2 * 1024 ** 3, cacheBytes: 0, sessionId: 'chat-1', chatTitle: 'Build the app', owner: 'label', project: 'shop', workingDir: '/work/shop' },
        { id: 'b', name: 'searxng', image: 'searxng', bytes: 1024 ** 3, cacheBytes: 0, sessionId: null, chatTitle: null, owner: null, project: null, workingDir: null },
      ],
    }) });
    render(<MemoryBadge />);
    expect(await screen.findByTestId('memory-badge')).toHaveTextContent('3.0 GB');
    fireEvent.click(screen.getByTestId('memory-badge'));
    const groups = await screen.findAllByTestId('memory-group');
    expect(groups.map(group => group.dataset.kind)).toEqual(['chat', 'other']);
    expect(groups[0]).toHaveTextContent('Build the app1 process · 1 container2.5 GB');
    expect(groups[1]).toHaveTextContent('Other containers1 container1.0 GB');
    fireEvent.click(screen.getByRole('button', { name: /Build the app/ }));
    const parts = within(groups[0]).getAllByTestId('memory-subgroup');
    expect(parts[0]).toHaveTextContent('Processes (1)512 MB');
    expect(parts[1]).toHaveTextContent('Containers (1)2.0 GB');
    expect(within(parts[1]).getByTestId('memory-container-row')).toHaveTextContent('shop-web');
    expect(screen.getByTestId('memory-container-line')).toHaveTextContent('Chat containers 2.0 GB');
  });

  // Each chat opens to its own process tree, nested by parent, and the app's
  // own processes sit under one entry split by what they do (bw-7as6r.1).
  it('nests each chat\'s processes under their parents and splits the app by role', async () => {
    const chat = { sessionId: 'chat-1', chatTitle: 'Build the app' };
    request.mockResolvedValue({ ok: true, json: async () => ({
      totalBytes: 1024 ** 3, swapBytes: 0, metric: 'pssWithSwap', processCount: 6,
      chats: [{ sessionId: 'chat-1', title: 'Build the app', bytes: 600, processes: 4 }],
      processDetails: [
        { pid: 10, parentPid: 1, name: 'atelier', bytes: 100, swapBytes: 0, sessionId: null, chatTitle: null, role: 'app', killable: false, startTime: 1 },
        { pid: 11, parentPid: 10, name: 'claude', bytes: 50, swapBytes: 0, sessionId: null, chatTitle: null, role: 'accountReader', killable: false, startTime: 2 },
        { pid: 20, parentPid: 10, name: 'claude-acp', bytes: 100, swapBytes: 0, ...chat, role: 'chatAdapter', killable: false, startTime: 3 },
        { pid: 21, parentPid: 20, name: 'claude', bytes: 300, swapBytes: 0, ...chat, role: 'provider', killable: false, startTime: 4 },
        { pid: 22, parentPid: 21, name: 'bash', bytes: 20, swapBytes: 0, ...chat, role: 'subprocess', killable: true, startTime: 5 },
        { pid: 23, parentPid: 22, name: 'cargo', bytes: 180, swapBytes: 0, ...chat, role: 'subprocess', killable: true, startTime: 6 },
      ],
    }) });
    render(<MemoryBadge />);
    fireEvent.click(await screen.findByTestId('memory-badge'));
    const groups = await screen.findAllByTestId('memory-group');
    expect(groups.map(group => group.dataset.kind)).toEqual(['chat', 'app']);
    expect(screen.queryAllByTestId('memory-process-row')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Build the app/ }));
    const rows = within(groups[0]).getAllByTestId('memory-process-row');
    expect(rows.map(row => [row.textContent?.match(/^└?(\S+?)(Chat|Agent|Sub)/)?.[1], row.dataset.depth]))
      .toEqual([['claude-acp', '0'], ['claude', '1'], ['bash', '2'], ['cargo', '3']]);
    fireEvent.click(screen.getByRole('button', { name: /^App/ }));
    const parts = within(groups[1]).getAllByTestId('memory-subgroup');
    expect(parts.map(part => part.textContent?.split(' (')[0])).toEqual(['Atelier app', 'Usage readers']);
  });

  it('gives a process charged to a chat the report no longer lists an entry of its own', () => {
    const groups = memoryGroups({
      totalBytes: 1, swapBytes: 0, metric: 'pssWithSwap', processCount: 1, chats: [],
      processDetails: [{ pid: 5, parentPid: null, name: 'node', bytes: 9, swapBytes: 0, sessionId: 'gone', chatTitle: null, role: 'subprocess', killable: true, startTime: 1 }],
    });
    expect(groups.map(group => [group.title, group.bytes])).toEqual([['Closed chat', 9]]);
  });
});
