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
const lineKeys = () => screen.getAllByTestId('close-chat-line').map((l) => l.getAttribute('data-key'));

/** Opens every folded branch, top down. */
async function unfold() {
  for (;;) {
    const shut = screen.queryAllByRole('button', { name: /^Expand / });
    if (!shut.length) return;
    await act(async () => void fireEvent.click(shut[0]));
  }
}

async function open() {
  const closed = vi.fn();
  render(<CloseChatDialog chat={{ sessionId: 's1', name: 'A chat' }} onCancel={() => {}} onClosed={closed} />);
  await waitFor(() => expect(screen.getAllByTestId('close-chat-line').length).toBeGreaterThan(0));
  return closed;
}

describe('closing a chat with things running', () => {
  it('opens with each process folded, so only the top of every run shows', async () => {
    await open();

    expect(lineKeys()).toEqual(['group:processes', 'p:20', 'p:30', 'group:containers', 'c:abc123']);
    expect(line('p:30').getAttribute('aria-expanded')).toBe('false');
    expect(line('p:30').getAttribute('data-state')).toBe('on');
    expect(screen.getByTestId('close-chat-confirm')).toHaveTextContent('Close and stop 4');

    await act(async () => void fireEvent.click(within(line('p:30')).getByRole('button', { name: /^Expand / })));
    expect(lineKeys()).toContain('p:31');
    expect(lineKeys()).not.toContain('p:32');
  });

  it('draws the processes as a tree beside the containers, everything ticked', async () => {
    await open();
    await unfold();

    expect(line('p:32').style.paddingLeft).not.toBe(line('p:30').style.paddingLeft);
    expect(line('group:processes').getAttribute('data-state')).toBe('on');
    expect(line('c:abc123').getAttribute('data-state')).toBe('on');
    expect(screen.getByTestId('close-chat-confirm')).toHaveTextContent('Close and stop 4');
  });

  it('shows the agent and its group as stopping with the chat, not to be cleared', async () => {
    await open();
    await unfold();

    expect(tick('p:22')).toBeDisabled();
    expect(within(line('p:22')).getByTestId('close-chat-locked')).toBeInTheDocument();
  });

  it('clearing a line clears what is under it, and only what is still ticked is stopped', async () => {
    const closed = await open();
    await unfold();

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

  it('opened for another chat, offers nothing of the last one while its list loads', async () => {
    const { rerender } = render(
      <CloseChatDialog chat={{ sessionId: 's1', name: 'A chat' }} onCancel={() => {}} onClosed={() => {}} />,
    );
    await waitFor(() => expect(screen.getByTestId('close-chat-confirm')).toHaveTextContent('Close and stop 4'));
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    rerender(<CloseChatDialog chat={null} onCancel={() => {}} onClosed={() => {}} />);
    rerender(<CloseChatDialog chat={{ sessionId: 's2', name: 'Another' }} onCancel={() => {}} onClosed={() => {}} />);

    expect(screen.getByTestId('close-chat-confirm')).toHaveTextContent('Close chat');
  });
});

/**
 * A folded line stands for everything under it, so its memory is the whole
 * branch's; an opened line shows only its own, since its children show theirs.
 * The numbers are PSS, so the sums do not count shared memory twice.
 */
describe('memory in the close chat window', () => {
  const memory = (key: string) => within(line(key)).queryByTestId('close-chat-memory');

  it('a folded line shows the memory of its whole branch, and says how it splits', async () => {
    await open();

    expect(memory('p:30')).toHaveTextContent('2.0 GB');
    expect(memory('p:30')).toHaveAccessibleName('48 MB itself, 1.9 GB in 2 processes under it');
  });

  it('an opened line shows only its own memory', async () => {
    await open();

    await act(async () => void fireEvent.click(within(line('p:30')).getByRole('button', { name: /^Expand / })));
    expect(memory('p:30')).toHaveTextContent('48 MB');
    expect(memory('p:30')).not.toHaveAccessibleName(/under it/);
    expect(memory('p:31')).toHaveTextContent('1.9 GB');
  });

  it('the Processes line shows the memory of every process', async () => {
    await open();

    expect(memory('group:processes')).toHaveTextContent('2.0 GB');
  });

  it('the button says how much memory the close frees', async () => {
    await open();

    expect(screen.getByTestId('close-chat-confirm')).toHaveTextContent('Close and stop 4 · frees 2.0 GB');
    await unfold();
    await act(async () => void fireEvent.click(tick('p:31')));
    expect(screen.getByTestId('close-chat-confirm')).toHaveTextContent('Close and stop 2 · frees 48 MB');
  });

  it('a line with no memory to speak of shows no number', async () => {
    await open();
    await unfold();

    expect(memory('p:20')).toBeNull();
    expect(memory('p:22')).toBeNull();
  });
});
