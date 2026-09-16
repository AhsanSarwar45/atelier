/**
 * The way out of the tray of chats waiting on you.
 *
 * It is a panel that drops out of a button on the shell's bar, and it was the
 * one such panel in the app built by hand rather than on the popover every
 * other one wears: a bare flag over an absolutely placed box. So it opened, and
 * then it stayed. A press anywhere else went to the page underneath and the
 * tray hung there over it — 384px of panel on a phone, and the only way to be
 * rid of it was to find the bell again (bw-l6hd.1).
 *
 * This asks the tray, not the popover, because what matters is that the panel a
 * reader actually opens closes for them.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveSession } from '@/workbench/live';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

/** One chat, stopped and asking its owner something. */
const ASKING = {
  id: 'chat-1',
  projectId: 'project-1',
  title: 'Waiting chat',
  state: 'waiting',
  waitingFor: 'permission',
} as unknown as LiveSession;
const FINISHED = { ...ASKING, id: 'chat-2', title: 'Finished chat', state: 'idle' } as LiveSession;
let sessions = [ASKING];

vi.mock('@/workbench/live', () => ({
  useLiveSessions: () => sessions,
  waitsOnYou: (session: LiveSession) => session.id === ASKING.id,
}));
vi.mock('@/lib/api', () => ({ projects: { list: () => Promise.resolve([]) } }));

async function openTheTray() {
  const { WorkbenchStatus } = await import('@/workbench/globals');
  await act(async () => void render(<WorkbenchStatus />));
  await act(async () => void fireEvent.click(screen.getByTestId('tray-badge')));
  await waitFor(() => expect(screen.queryByTestId('tray-panel')).not.toBeNull());
}

beforeEach(() => {
  push.mockClear();
  sessions = [ASKING];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the tray of chats waiting on you', () => {
  it('closes when the page behind it is pressed', async () => {
    await openTheTray();

    // Where a reader's finger actually lands: the page, not the tray. Radix
    // watches for the press going down rather than the click coming up, which
    // is why a plain `click` here would prove nothing.
    await act(async () => void fireEvent.pointerDown(document.body));

    await waitFor(() => expect(screen.queryByTestId('tray-panel')).toBeNull());
    expect(push, 'pressing the page behind the tray went somewhere').not.toHaveBeenCalled();
  });

  it('closes when Escape is pressed', async () => {
    await openTheTray();

    await act(async () => void fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }));

    await waitFor(() => expect(screen.queryByTestId('tray-panel')).toBeNull());
  });

  it('still lands on the chat a row names, and puts itself away doing it', async () => {
    await openTheTray();

    await act(async () => void fireEvent.click(screen.getByTestId('tray-row')));

    expect(push).toHaveBeenCalledWith(expect.stringContaining('chat=chat-1'));
    await waitFor(() => expect(screen.queryByTestId('tray-panel')).toBeNull());
  });

  it('says on the bell whether it is open, for the bar to draw it pressed', async () => {
    await openTheTray();
    expect(screen.getByTestId('tray-badge')).toHaveAttribute('data-open', 'true');

    await act(async () => void fireEvent.keyDown(document.body, { key: 'Escape' }));
    await waitFor(() => expect(screen.getByTestId('tray-badge')).toHaveAttribute('data-open', 'false'));
  });

  it('separates work that needs action from other updates', async () => {
    sessions = [ASKING, FINISHED];
    await openTheTray();

    expect(screen.getByText('Needs action')).toBeVisible();
    expect(screen.getByText('Other updates')).toBeVisible();
    expect(screen.getByText('Waiting chat')).toBeVisible();
    expect(screen.getByText('Finished chat')).toBeVisible();
    expect(screen.getByTestId('tray-count')).toHaveTextContent('2');
  });
});
