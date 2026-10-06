/**
 * The window that closes a chat lists what it still has running and stops what
 * is ticked (bw-fbtyy.1). What sits in the agent's own process group stops with
 * the chat anyway, so it is shown ticked and cannot be cleared.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloseChatDialog, type ChatRunning } from '@/workbench/close-chat-dialog';

const RUNNING: ChatRunning = {
  processes: [
    { pid: 20, parentPid: 1, name: 'claude-agent-acp', command: 'claude-agent-acp', bytes: 0, startTime: 1, role: 'agent', closesWithChat: true },
    { pid: 21, parentPid: 20, name: 'claude', command: 'claude', bytes: 0, startTime: 1, role: 'agent', closesWithChat: true },
    { pid: 22, parentPid: 21, name: 'bash', command: 'bash -c npm test', bytes: 0, startTime: 1, role: 'subprocess', closesWithChat: true },
    { pid: 30, parentPid: 1, name: 'npm', command: 'npm exec jest', bytes: 50_000_000, startTime: 7, role: 'subprocess', closesWithChat: false },
    { pid: 31, parentPid: 30, name: 'node', command: 'node jest', bytes: 90_000_000, startTime: 8, role: 'subprocess', closesWithChat: false },
    { pid: 32, parentPid: 31, name: 'mongod', command: 'mongod --port 1', bytes: 2_000_000_000, startTime: 9, role: 'subprocess', closesWithChat: false },
  ],
  containers: [{ id: 'abc123', name: 'shop-db-1', image: 'postgres:16', project: 'shop' }],
};

let posted: { url: string; body: unknown }[] = [];

beforeEach(() => {
  posted = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body ?? '{}') });
        return { ok: true, json: async () => ({ failures: [] }) } as unknown as Response;
      }
      return { ok: true, json: async () => RUNNING } as unknown as Response;
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const line = (key: string) =>
  screen.getAllByTestId('close-chat-line').find((l) => l.getAttribute('data-key') === key)!;
const tick = (key: string) => within(line(key)).getByTestId('close-chat-tick');

async function open() {
  const closed = vi.fn();
  render(<CloseChatDialog chat={{ sessionId: 's1', name: 'A chat' }} onCancel={() => {}} onClosed={closed} />);
  await waitFor(() => expect(screen.getAllByTestId('close-chat-line').length).toBeGreaterThan(0));
  return closed;
}

describe('closing a chat with things running', () => {
  it('draws the processes as a tree beside the containers, everything ticked', async () => {
    await open();

    expect(line('p:32').style.paddingLeft).not.toBe(line('p:30').style.paddingLeft);
    expect(line('group:processes').getAttribute('data-state')).toBe('on');
    expect(line('c:abc123').getAttribute('data-state')).toBe('on');
    expect(screen.getByTestId('close-chat-confirm')).toHaveTextContent('Close and stop 4');
  });

  it('shows the agent and its group as stopping with the chat, not to be cleared', async () => {
    await open();

    expect(tick('p:22')).toBeDisabled();
    expect(within(line('p:22')).getByTestId('close-chat-locked')).toBeInTheDocument();
  });

  it('clearing a line clears what is under it, and only what is still ticked is stopped', async () => {
    const closed = await open();

    await act(async () => void fireEvent.click(tick('p:31')));
    expect(line('p:32').getAttribute('data-state')).toBe('off');
    expect(line('group:processes').getAttribute('data-state')).toBe('half');

    await act(async () => void fireEvent.click(screen.getByTestId('close-chat-confirm')));

    await waitFor(() => expect(closed).toHaveBeenCalledWith([]));
    expect(posted.map((p) => p.body)).toEqual([
      { type: 'session.close', sessionId: 's1' },
      { processes: [{ pid: 30, startTime: 7 }], containers: ['abc123'] },
    ]);
    expect(posted[1].url).toContain('/api/workbench/session/s1/running/stop');
  });

  it('with nothing ticked, only closes the chat', async () => {
    await open();

    await act(async () => void fireEvent.click(tick('group:processes')));
    await act(async () => void fireEvent.click(tick('group:containers')));
    expect(screen.getByTestId('close-chat-confirm')).toHaveTextContent('Close chat');
    await act(async () => void fireEvent.click(screen.getByTestId('close-chat-confirm')));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].body).toEqual({ type: 'session.close', sessionId: 's1' });
  });
});
