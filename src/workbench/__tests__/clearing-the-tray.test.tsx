/**
 * Being done with what the notification tray is showing.
 *
 * The rows in there are not messages that arrive and stay: each one is a live
 * reading of what a chat is doing right now. So "clear" cannot mean "delete" —
 * there is nothing to delete — and it cannot mean "never show this chat again"
 * either, or a chat cleared while it wanted permission would stay silent when
 * it went on to want something else. It means: I have read these, in the state
 * they are in (bw-k22y.1).
 *
 * Who remembers that reading is the point of this file now. It used to be the
 * browser, in a key of its own, and it was therefore wrong twice over: a phone
 * that threw the tab away brought every dismissed row back (bw-poyg), and a
 * clearing done on the phone meant nothing at the desk (bw-altj). So the tray
 * asks the server what to say and tells the server what was read, and keeps
 * nothing. These tests stand a small server in for the real one and check the
 * tray against it — that it draws the answer, and that clearing sends the
 * states it actually showed.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveSession } from '@/workbench/live';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

/**
 * The chats, as the server holds them, and what it has been told was read.
 *
 * `read` is the state a chat was in when the owner last read it — which is how
 * a cleared chat comes back the moment it goes on to do something else, and
 * stays away as long as it does not.
 */
interface Chat {
  id: string;
  title: string;
  state: string;
  says: string;
}
let chats: Chat[] = [];
let read = new Map<string, string>();

function worthSaying() {
  return chats
    .filter((chat) => read.get(chat.id) !== chat.state)
    .map((chat) => ({
      id: chat.id,
      name: chat.title,
      projectId: 'project-1',
      projectName: 'Keystone',
      state: chat.state,
      says: chat.says,
      href: `/projects/project-1?chat=${chat.id}`,
      needsAction: chat.state === 'waiting_permission' || chat.state === 'errored',
    }))
    .sort((a, b) => Number(b.needsAction) - Number(a.needsAction));
}

const request = vi.fn(async (path: string, options?: { body?: string }) => {
  if (path === '/api/workbench/notifications') {
    return { ok: true, status: 200, json: async () => worthSaying() } as unknown as Response;
  }
  if (path === '/api/workbench/notifications/read') {
    const sent = JSON.parse(options?.body ?? '{}') as { chats: { id: string; state: string }[] };
    for (const chat of sent.chats) read.set(chat.id, chat.state);
    return { ok: true, status: 204 } as unknown as Response;
  }
  throw new Error(`the tray asked for something else: ${path}`);
});
vi.mock('@/lib/api', () => ({ request: (path: string, options?: { body?: string }) => request(path, options) }));

// The stream is only the prompt to ask again: it says a chat moved, the tray
// asks the server what that means. Nothing here is drawn from it.
let sessions: LiveSession[] = [];
vi.mock('@/workbench/live', () => ({ useLiveSessions: () => sessions }));

const ASKING: Chat = { id: 'chat-1', title: 'Waiting chat', state: 'waiting_permission', says: 'It is waiting on you' };
const FINISHED: Chat = { id: 'chat-2', title: 'Finished chat', state: 'idle', says: 'Ready to read' };

async function theBar() {
  const { WorkbenchStatus } = await import('@/workbench/globals');
  let view!: ReturnType<typeof render>;
  await act(async () => void (view = render(<WorkbenchStatus />)));
  await waitFor(() => expect(request).toHaveBeenCalled());
  return view;
}

async function openTheTray() {
  const view = await theBar();
  await waitFor(() => expect(screen.queryByTestId('tray-badge')).not.toBeNull());
  await act(async () => void fireEvent.click(screen.getByTestId('tray-badge')));
  await waitFor(() => expect(screen.queryByTestId('tray-panel')).not.toBeNull());
  return view;
}

beforeEach(() => {
  push.mockClear();
  request.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  chats = [{ ...ASKING }, { ...FINISHED }];
  read = new Map();
  sessions = [];
});

afterEach(() => vi.clearAllMocks());

describe('clearing the notification tray', () => {
  it('empties the tray, and takes the bell with it', async () => {
    await openTheTray();
    expect(screen.getAllByTestId('tray-row')).toHaveLength(2);

    await act(async () => void fireEvent.click(screen.getByTestId('tray-clear')));

    await waitFor(() => expect(screen.queryByTestId('tray-row')).toBeNull());
    // The bell is the tray: with nothing left to say it says nothing, rather
    // than sitting in the bar with a zero on it.
    expect(screen.queryByTestId('tray-badge'), 'the bell stayed after everything was cleared').toBeNull();
    expect(push, 'clearing went somewhere').not.toHaveBeenCalled();
  });

  it('tells the server what was read, in the states it was showing', async () => {
    await openTheTray();

    await act(async () => void fireEvent.click(screen.getByTestId('tray-clear')));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/api/workbench/notifications/read',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(read.get('chat-1')).toBe('waiting_permission');
    expect(read.get('chat-2')).toBe('idle');
  });

  it('stays cleared for a page that never saw the clearing', async () => {
    const first = await openTheTray();
    await act(async () => void fireEvent.click(screen.getByTestId('tray-clear')));
    await waitFor(() => expect(screen.queryByTestId('tray-badge')).toBeNull());
    first.unmount();

    // What a phone hands back: a tab that never saw the clearing, and nothing
    // in any browser storage to tell it what happened. It asks, and the server
    // is the one that remembers.
    localStorage.clear();
    sessionStorage.clear();
    await theBar();

    await waitFor(() => expect(screen.queryByTestId('tray-badge')).toBeNull());
    expect(screen.queryByTestId('tray-row'), 'a chat cleared elsewhere came back unchanged').toBeNull();
  });

  it('brings a cleared chat back the moment it wants something else', async () => {
    await openTheTray();
    await act(async () => void fireEvent.click(screen.getByTestId('tray-clear')));
    await waitFor(() => expect(screen.queryByTestId('tray-badge')).toBeNull());

    // The chat that was waiting on permission has stopped with an error: a new
    // thing to say about a chat already read.
    chats = [{ ...ASKING, state: 'errored', says: 'It stopped with an error' }, { ...FINISHED }];
    await theBar();
    await waitFor(() => expect(screen.queryByTestId('tray-badge')).not.toBeNull());
    await act(async () => void fireEvent.click(screen.getByTestId('tray-badge')));

    await waitFor(() => expect(screen.getAllByTestId('tray-row')).toHaveLength(1));
    expect(screen.getByTestId('tray-row').textContent).toContain('Waiting chat');
  });

  it('keeps no record of its own in either browser storage', async () => {
    await openTheTray();
    await act(async () => void fireEvent.click(screen.getByTestId('tray-clear')));
    await waitFor(() => expect(screen.queryByTestId('tray-badge')).toBeNull());

    expect(localStorage.length, `the tray wrote ${JSON.stringify({ ...localStorage })}`).toBe(0);
    expect(sessionStorage.length, `the tray wrote ${JSON.stringify({ ...sessionStorage })}`).toBe(0);
  });
});
