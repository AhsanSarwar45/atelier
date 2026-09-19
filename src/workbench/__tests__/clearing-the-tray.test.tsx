/**
 * Being done with what the notification tray is showing.
 *
 * The rows in there are not messages that arrive and stay: each one is a live
 * reading of what a chat is doing right now. So "clear" cannot mean "delete" —
 * there is nothing to delete — and it cannot mean "never show this chat again"
 * either, or a chat cleared while it wanted permission would stay silent when
 * it went on to want something else. It means: I have read these, in the state
 * they are in (bw-k22y.1).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveSession } from '@/workbench/live';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const ASKING = {
  id: 'chat-1',
  projectId: 'project-1',
  title: 'Waiting chat',
  state: 'waiting_permission',
  waitingFor: 'permission',
} as unknown as LiveSession;
const FINISHED = { ...ASKING, id: 'chat-2', title: 'Finished chat', state: 'idle', waitingFor: null } as LiveSession;

let sessions: LiveSession[] = [ASKING, FINISHED];

vi.mock('@/workbench/live', () => ({
  useLiveSessions: () => sessions,
  waitsOnYou: (session: LiveSession) => session.state === 'waiting_permission' || session.state === 'errored',
}));
vi.mock('@/lib/api', () => ({ projects: { list: () => Promise.resolve([]) } }));

async function theBar() {
  const { WorkbenchStatus } = await import('@/workbench/globals');
  let view!: ReturnType<typeof render>;
  await act(async () => void (view = render(<WorkbenchStatus />)));
  return view;
}

async function openTheTray() {
  const view = await theBar();
  await act(async () => void fireEvent.click(screen.getByTestId('tray-badge')));
  await waitFor(() => expect(screen.queryByTestId('tray-panel')).not.toBeNull());
  return view;
}

beforeEach(() => {
  push.mockClear();
  sessionStorage.clear();
  sessions = [ASKING, FINISHED];
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

  it('stays cleared when the same chats are read again', async () => {
    const first = await openTheTray();
    await act(async () => void fireEvent.click(screen.getByTestId('tray-clear')));
    first.unmount();

    await theBar();

    expect(screen.queryByTestId('tray-row'), 'a cleared chat came back unchanged').toBeNull();
  });

  it('brings a cleared chat back the moment it wants something else', async () => {
    await openTheTray();
    await act(async () => void fireEvent.click(screen.getByTestId('tray-clear')));
    await waitFor(() => expect(screen.queryByTestId('tray-badge')).toBeNull());

    // The chat that was waiting on permission has stopped with an error: a new
    // thing to say about a chat already read.
    sessions = [{ ...ASKING, state: 'errored' } as unknown as LiveSession, FINISHED];
    await theBar();
    await act(async () => void fireEvent.click(screen.getByTestId('tray-badge')));

    await waitFor(() => expect(screen.getAllByTestId('tray-row')).toHaveLength(1));
    expect(screen.getByTestId('tray-row').textContent).toContain('Waiting chat');
  });
});
