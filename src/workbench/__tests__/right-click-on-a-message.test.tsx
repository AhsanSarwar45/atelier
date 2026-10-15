/**
 * A right-click on a message, or a long press on a phone, opens a menu of what
 * can be done with it (bw-yszdw). Asked here: that "Copy message" copies the
 * words as they were written, that text selected inside the message is offered
 * as well, and that a link keeps the browser's own menu.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import type { TranscriptItem } from '@/workbench/fold';
import { TranscriptRow } from '@/workbench/transcript-rows';

/** Words drawn as words: nothing in these messages is a path or a card. */
const PLAINLY: Mentions = { split: (text) => [{ kind: 'text', text }], card: () => null };

const said = (text: string): TranscriptItem => ({
  kind: 'message',
  id: 'reply',
  role: 'assistant',
  text,
  images: [],
  done: true,
  parentId: null,
});

let written = vi.fn();
beforeEach(() => {
  written = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: written }, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
});

const draw = (text: string) =>
  render(<TranscriptRow item={said(text)} sessionId="chat-1" mentions={PLAINLY} onLook={() => {}} />);

it('copies the message as it was written', async () => {
  draw('The **fix** is in.');
  fireEvent.contextMenu(screen.getByTestId('assistant-message'), { clientX: 20, clientY: 20 });
  await waitFor(() => expect(screen.queryByTestId('message-menu')).not.toBeNull());
  expect(screen.queryByTestId('message-menu-copy-selection')).toBeNull();
  fireEvent.click(screen.getByTestId('message-menu-copy'));
  await waitFor(() => expect(written).toHaveBeenCalledWith('The **fix** is in.'));
});

it('offers the selected text when some of the message is selected', async () => {
  draw('first words then more');
  const message = screen.getByTestId('assistant-message');
  const words = screen.getByText(/first words/).firstChild!;
  const range = document.createRange();
  range.setStart(words, 0);
  range.setEnd(words, 'first words'.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.contextMenu(message, { clientX: 20, clientY: 20 });
  fireEvent.click(await screen.findByTestId('message-menu-copy-selection'));
  await waitFor(() => expect(written).toHaveBeenCalledWith('first words'));
});

it('opens on a long press from a finger', async () => {
  vi.useFakeTimers();
  draw('held');
  const message = screen.getByTestId('assistant-message');
  fireEvent.pointerDown(message, { pointerType: 'touch', clientX: 20, clientY: 20 });
  act(() => void vi.advanceTimersByTime(600));
  expect(screen.queryByTestId('message-menu')).not.toBeNull();
});

it('leaves a right-click on a link to the browser', () => {
  draw('See [the docs](https://example.com).');
  const link = screen.getByRole('link');
  const shown = fireEvent.contextMenu(link, { clientX: 20, clientY: 20 });
  expect(shown).toBe(true);
  expect(screen.queryByTestId('message-menu')).toBeNull();
});
