/**
 * The way out of the terminal's command-history panel.
 *
 * Escape has always closed it, and for a panel people reach by keyboard that
 * covered most of it. But it fills its terminal edge to edge, so a reader who
 * puts a finger on the chat beside it is pressing the one thing that used to do
 * nothing at all — the panel stayed up over the shell until they found the
 * button it came out of again (bw-l6hd.2).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { HistoryPanel } from '@/workbench/terminal-history';

vi.mock('@/lib/api', () => ({
  request: () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ shell: 'bash', readable: true, commands: [{ command: 'git status', at: null }] }),
    }),
}));

const drawn = async (onClose: () => void) => {
  await act(async () => void render(<HistoryPanel onPick={() => {}} onClose={onClose} />));
  await waitFor(() => expect(screen.queryByTestId('terminal-history-panel')).not.toBeNull());
};

afterEach(() => vi.clearAllMocks());

it('closes when something outside it is pressed', async () => {
  const onClose = vi.fn();
  await drawn(onClose);

  await act(async () => void fireEvent.pointerDown(document.body));

  expect(onClose, 'the panel sat through a press on the app behind it').toHaveBeenCalled();
});

it('sits still when the press lands on the panel itself', async () => {
  const onClose = vi.fn();
  await drawn(onClose);

  await act(async () => void fireEvent.pointerDown(screen.getByTestId('terminal-history-search')));

  expect(onClose, 'typing in the search box put the search box away').not.toHaveBeenCalled();
});

it('leaves the button it came out of alone, so a press there does not close and reopen it', async () => {
  const onClose = vi.fn();
  await drawn(onClose);

  // The opener toggles. Were this press to close the panel on the way down,
  // the button's own click would open it again on the way up, and the panel
  // would look like it ignored the press.
  const opener = document.createElement('button');
  opener.setAttribute('data-testid', 'terminal-history-open');
  document.body.append(opener);
  try {
    await act(async () => void fireEvent.pointerDown(opener));
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    opener.remove();
  }
});

it('stops listening once it is gone', async () => {
  const onClose = vi.fn();
  const { unmount } = await act(async () =>
    render(<HistoryPanel onPick={() => {}} onClose={onClose} />),
  );
  unmount();

  await act(async () => void fireEvent.pointerDown(document.body));

  expect(onClose, 'the panel is still watching the page after it was taken away').not.toHaveBeenCalled();
});
