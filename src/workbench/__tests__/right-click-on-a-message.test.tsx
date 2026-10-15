/**
 * A right-click on a message, or a long press on a phone, opens a menu of what
 * can be done with it (bw-yszdw). Asked here: that "Copy message" copies the
 * words as they were written, that text selected inside the message is offered
 * as well, and that a link keeps the browser's own menu. In the open chat it
 * also offers Resend and Edit and resend on his own messages, Quote in reply,
 * and a link to the message (bw-drvtr.2).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import { imageMarker, promptFromDraft } from '@/workbench/composer-attachments';
import type { TranscriptItem } from '@/workbench/fold';
import { MessageRepliesContext, messageAsDraft, quoted, type MessageReplies } from '@/workbench/message-menu';
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

describe('in the open chat', () => {
  const replies = () => ({ resend: vi.fn(), edit: vi.fn(), quote: vi.fn(), linkTo: vi.fn((id: string) => `/project?id=p&tab=chat&chat=c&message=${id}`) });
  const mine = (text: string, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({ ...said(text), id: 'mine', role: 'user', ...extra } as TranscriptItem);
  const drawIn = (item: TranscriptItem, value: MessageReplies) =>
    render(
      <MessageRepliesContext.Provider value={value}>
        <TranscriptRow item={item} sessionId="chat-1" mentions={PLAINLY} onLook={() => {}} />
      </MessageRepliesContext.Provider>,
    );
  const open = async (testId: string) => {
    fireEvent.contextMenu(screen.getByTestId(testId), { clientX: 20, clientY: 20 });
    await screen.findByTestId('message-menu');
  };

  it('resends his own message, words and all', async () => {
    const value = replies();
    drawIn(mine('Run the tests again.'), value);
    await open('user-message');
    fireEvent.click(screen.getByTestId('message-menu-resend'));
    expect(value.resend).toHaveBeenCalledWith('Run the tests again.', []);
  });

  it('puts his own message in the box to edit', async () => {
    const value = replies();
    drawIn(mine('Fix the header.'), value);
    await open('user-message');
    fireEvent.click(screen.getByTestId('message-menu-edit'));
    expect(value.edit).toHaveBeenCalledWith('Fix the header.', []);
  });

  it('offers no resend on the agent’s reply, and quotes it', async () => {
    const value = replies();
    drawIn(said('Done.\nAll green.'), value);
    await open('assistant-message');
    expect(screen.queryByTestId('message-menu-resend')).toBeNull();
    expect(screen.queryByTestId('message-menu-edit')).toBeNull();
    fireEvent.click(screen.getByTestId('message-menu-quote'));
    expect(value.quote).toHaveBeenCalledWith('Done.\nAll green.');
  });

  it('copies a link that opens the chat at the message', async () => {
    const value = replies();
    drawIn(said('Here.'), value);
    await open('assistant-message');
    fireEvent.click(screen.getByTestId('message-menu-copy-link'));
    await waitFor(() => expect(written).toHaveBeenCalledWith(`${window.location.origin}/project?id=p&tab=chat&chat=c&message=reply`));
  });

  it('offers only copying where no chat is open', async () => {
    draw('Elsewhere.');
    fireEvent.contextMenu(screen.getByTestId('assistant-message'), { clientX: 20, clientY: 20 });
    await screen.findByTestId('message-menu');
    expect(screen.queryByTestId('message-menu-quote')).toBeNull();
    expect(screen.queryByTestId('message-menu-copy-link')).toBeNull();
  });
});

it('a sent message goes back into the box with each picture where it sat', () => {
  const shot = { mime: 'image/png', dataUrl: '', alt: 'a.png', asset: 'x.png', at: 4 };
  const { draft, pictures } = messageAsDraft({ text: 'See  here', images: [shot] });
  expect(pictures).toHaveLength(1);
  expect(draft).toBe(`See ${imageMarker(pictures[0]!.id)} here`);
  expect(promptFromDraft(draft, pictures).images[0]!.at).toBe(4);
});

it('quotes every line and leaves a line to answer on', () => {
  expect(quoted('one\n\ntwo\n')).toBe('> one\n>\n> two\n\n');
});
