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

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

/** One chat, stopped and asking its owner something, as the server sends it. */
const ASKING = {
  id: 'chat-1',
  name: 'Waiting chat',
  projectId: 'project-1',
  projectName: 'Keystone',
  state: 'waiting_permission',
  says: 'It is waiting on you',
  href: '/projects/project-1?chat=chat-1',
  needsAction: true,
  at: '2026-09-22T08:15:00.000Z',
};
const FINISHED = {
  ...ASKING,
  id: 'chat-2',
  name: 'Finished chat',
  state: 'idle',
  says: 'Ready to read',
  href: '/projects/project-1?chat=chat-2',
  needsAction: false,
};
let rows = [ASKING];

// The tray draws what the server hands it, so that is what stands in for a
// server here. The live stream is only its cue to ask again.
vi.mock('@/lib/api', () => ({
  request: async (path: string) =>
    ({ ok: true, status: path.endsWith('/read') ? 204 : 200, json: async () => rows }) as unknown as Response,
}));
vi.mock('@/workbench/live', () => ({ useLiveSessions: () => [] }));

async function openTheTray() {
  const { WorkbenchStatus } = await import('@/workbench/globals');
  await act(async () => void render(<WorkbenchStatus />));
  await waitFor(() => expect(screen.queryByTestId('tray-badge')).not.toBeNull());
  await act(async () => void fireEvent.click(screen.getByTestId('tray-badge')));
  await waitFor(() => expect(screen.queryByTestId('tray-panel')).not.toBeNull());
}

beforeEach(() => {
  push.mockClear();
  rows = [ASKING];
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
    rows = [ASKING, FINISHED];
    await openTheTray();

    expect(screen.getByText('Needs action')).toBeVisible();
    expect(screen.getByText('Other updates')).toBeVisible();
    expect(screen.getByText('Waiting chat')).toBeVisible();
    expect(screen.getByText('Finished chat')).toBeVisible();
    expect(screen.getByTestId('tray-count')).toHaveTextContent('2');
  });
});
