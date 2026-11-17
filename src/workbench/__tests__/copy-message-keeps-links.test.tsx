/**
 * "Copy message" gives a rich paste the same thing a selection and Ctrl+C do:
 * the message drawn as HTML, so a link pastes as a link, beside the words as
 * read for a plain paste.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import type { TranscriptItem } from '@/workbench/fold';
import { TranscriptRow } from '@/workbench/transcript-rows';

const PLAINLY: Mentions = { split: (text) => [{ kind: 'text', text }] };

const WRITTEN = '- [KEY-2321](https://linear.app/wq/issue/KEY-2321/grade-appeals) - Finish the **Assistant** link';

class FakeClipboardItem {
  constructor(readonly parts: Record<string, Blob>) {}
}

let items: FakeClipboardItem[][] = [];
beforeEach(() => {
  items = [];
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(async (given: FakeClipboardItem[]) => void items.push(given)),
    },
    configurable: true,
  });
});
afterEach(() => vi.unstubAllGlobals());

it('copies a message with its links as HTML and its words as read', async () => {
  const item: TranscriptItem = { kind: 'message', id: 'r', role: 'assistant', text: WRITTEN, images: [], done: true, parentId: null };
  render(<TranscriptRow item={item} sessionId="chat-1" mentions={PLAINLY} onLook={() => {}} />);
  fireEvent.contextMenu(screen.getByTestId('assistant-message'), { clientX: 20, clientY: 20 });
  fireEvent.click(await screen.findByTestId('message-menu-copy'));
  await waitFor(() => expect(items.length).toBe(1));
  const parts = items[0][0].parts;
  const html = await parts['text/html']?.text();
  const plain = await parts['text/plain']?.text();
  console.log(`html=${html}`);
  expect(html).toContain('<a href="https://linear.app/wq/issue/KEY-2321/grade-appeals">KEY-2321</a>');
  expect(html).toContain('<strong>Assistant</strong>');
  expect(plain).toBe('- KEY-2321 - Finish the Assistant link');
});

it('never carries raw HTML written in a message onto the clipboard as markup', async () => {
  const text = 'Before <img src=x onerror="alert(1)"> after';
  const item: TranscriptItem = { kind: 'message', id: 'r', role: 'assistant', text, images: [], done: true, parentId: null };
  render(<TranscriptRow item={item} sessionId="chat-1" mentions={PLAINLY} onLook={() => {}} />);
  fireEvent.contextMenu(screen.getByTestId('assistant-message'), { clientX: 20, clientY: 20 });
  fireEvent.click(await screen.findByTestId('message-menu-copy'));
  await waitFor(() => expect(items.length).toBe(1));
  const html = (await items[0][0].parts['text/html']?.text()) ?? '';
  console.log(`html=${html}`);
  expect(html).toContain('Before');
  expect(html).not.toMatch(/<img/);
});
