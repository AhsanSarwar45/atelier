/**
 * What a window announces to the device it is open on, and what it keeps quiet.
 *
 * A page that announced everything already in the tray would fire a handful of
 * system notifications every time the owner opened a tab — for chats he read
 * yesterday, in states nothing has changed about. So opening a page is not
 * news: the first answer from the server is a reading, not an event, and only
 * what moves after it is announced.
 *
 * The trap this pins down is that the first answer is the SECOND thing the
 * page holds. It starts on an empty list because it has not asked yet, and a
 * page that took that emptiness for a reading would find the whole first
 * answer new — which is the same handful of notifications, from the other end.
 */
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const shown = vi.fn();
vi.mock('@/workbench/notification-preferences', async () => {
  const real = await vi.importActual<typeof import('@/workbench/notification-preferences')>(
    '@/workbench/notification-preferences',
  );
  return {
    ...real,
    showDeviceNotification: (...args: unknown[]) => shown(...args),
    // The owner has device notifications on; that is the setting under test.
    readNotificationPreferences: () => ({ needsAction: true, updates: true, device: true }),
    useNotificationPreferences: () => ({
      preferences: { needsAction: true, updates: true, device: true },
      save: vi.fn(),
    }),
  };
});

const ASKING = {
  id: 'chat-1',
  title: 'Waiting chat',
  projectId: 'project-1',
  projectName: 'Keystone',
  state: 'waiting_permission',
  says: 'permission to use a tool',
  href: '/project?id=project-1&tab=chat&chat=chat-1',
  needsAction: true,
};
let rows = [ASKING];

vi.mock('@/lib/api', () => ({
  request: async () => ({ ok: true, status: 200, json: async () => rows }) as unknown as Response,
}));
// The stream is the tray's cue to ask the server again, so this is how a chat
// is made to move while the page stays up.
let sessions: { id: string; state: string }[] = [];
vi.mock('@/workbench/live', () => ({ useLiveSessions: () => sessions }));

async function theBar() {
  const { WorkbenchStatus } = await import('@/workbench/globals');
  let view!: ReturnType<typeof render>;
  await act(async () => void (view = render(<WorkbenchStatus />)));
  return view;
}

beforeEach(() => {
  shown.mockClear();
  rows = [ASKING];
  sessions = [{ id: 'chat-1', state: 'waiting_permission' }];
});

afterEach(() => vi.clearAllMocks());

describe('what a page announces to its device', () => {
  it('says nothing about what was already there when it opened', async () => {
    const view = await theBar();
    await waitFor(() => expect(view.queryByTestId('tray-badge')).not.toBeNull());

    expect(shown, 'a page announced a chat merely for being open').not.toHaveBeenCalled();
  });

  it('announces a chat that moves on while the page is up', async () => {
    const view = await theBar();
    await waitFor(() => expect(view.queryByTestId('tray-badge')).not.toBeNull());
    expect(shown).not.toHaveBeenCalled();

    // The chat that was asking has stopped with an error. The stream says so,
    // which sends the page back to the server, which answers differently: a new
    // thing to say about a chat this page has already seen.
    rows = [{ ...ASKING, state: 'errored', says: 'it stopped with an error' }];
    sessions = [{ id: 'chat-1', state: 'errored' }];
    const { WorkbenchStatus } = await import('@/workbench/globals');
    await act(async () => void view.rerender(<WorkbenchStatus />));

    await waitFor(() => expect(shown).toHaveBeenCalledTimes(1));
    expect(shown).toHaveBeenCalledWith('Waiting chat', 'it stopped with an error', ASKING.href);
  });

  it('does not say the same thing twice while the page stays up', async () => {
    const view = await theBar();
    await waitFor(() => expect(view.queryByTestId('tray-badge')).not.toBeNull());

    rows = [{ ...ASKING, state: 'errored', says: 'it stopped with an error' }];
    sessions = [{ id: 'chat-1', state: 'errored' }];
    const { WorkbenchStatus } = await import('@/workbench/globals');
    await act(async () => void view.rerender(<WorkbenchStatus />));
    await waitFor(() => expect(shown).toHaveBeenCalledTimes(1));

    // The stream carries a frame that changes nothing about any state. The
    // answer is the same answer, so the device hears nothing further.
    sessions = [{ id: 'chat-1', state: 'errored' }];
    await act(async () => void view.rerender(<WorkbenchStatus />));

    expect(shown, 'the same standing was announced twice').toHaveBeenCalledTimes(1);
  });
});
