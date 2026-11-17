/**
 * The message menu copies two ways. "Copy message" gives what a selection and
 * Ctrl+C give: HTML for a rich paste and the words as read, without markdown
 * marks, for a plain one. "Copy as Markdown" gives the words as written.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import type { TranscriptItem } from '@/workbench/fold';
import { TranscriptRow } from '@/workbench/transcript-rows';

const PLAINLY: Mentions = { split: (text) => [{ kind: 'text', text }] };

const WRITTEN = 'Plans:\n\n- [KEY-2321](https://linear.app/wq/issue/KEY-2321) - Finish the **Assistant** link\n- Ship it';

class FakeClipboardItem {
  constructor(readonly parts: Record<string, Blob>) {}
}

let items: FakeClipboardItem[][] = [];
let texts: string[] = [];
beforeEach(() => {
  items = [];
  texts = [];
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: vi.fn(async (text: string) => void texts.push(text)),
      write: vi.fn(async (given: FakeClipboardItem[]) => void items.push(given)),
    },
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.getSelection()?.removeAllRanges();
});

async function pick(testId: string) {
  const item: TranscriptItem = { kind: 'message', id: 'r', role: 'assistant', text: WRITTEN, images: [], done: true, parentId: null };
  render(<TranscriptRow item={item} sessionId="chat-1" mentions={PLAINLY} onLook={() => {}} />);
  fireEvent.contextMenu(screen.getByTestId('assistant-message'), { clientX: 20, clientY: 20 });
  const choice = await screen.findByTestId('message-menu').then(() => screen.queryByTestId(testId));
  console.log(`menu item ${testId}: ${choice ? 'present' : 'missing'}`);
  expect(choice).not.toBeNull();
  fireEvent.click(choice!);
}

it('Copy message gives a plain paste the words as read, without markdown marks', async () => {
  await pick('message-menu-copy');
  await waitFor(() => expect(items.length).toBe(1));
  const plain = await items[0][0].parts['text/plain']?.text();
  console.log(`plain=${JSON.stringify(plain)}`);
  expect(plain).toBe('Plans:\n\n- KEY-2321 - Finish the Assistant link\n- Ship it');
});

it('Copy as Markdown gives the words as written, and nothing else', async () => {
  await pick('message-menu-copy-markdown');
  await waitFor(() => expect(texts).toEqual([WRITTEN]));
  expect(items).toEqual([]);
});

/** Select the whole list item that holds the link, then open the menu over it. */
async function pickOverSelection(testId: string) {
  const item: TranscriptItem = { kind: 'message', id: 'r', role: 'assistant', text: WRITTEN, images: [], done: true, parentId: null };
  render(<TranscriptRow item={item} sessionId="chat-1" mentions={PLAINLY} onLook={() => {}} />);
  const message = screen.getByTestId('assistant-message');
  const line = message.querySelector('li')!;
  const range = document.createRange();
  range.setStart(line, 0);
  range.setEnd(line, line.childNodes.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.contextMenu(message, { clientX: 20, clientY: 20 });
  await screen.findByTestId('message-menu');
  const choice = screen.queryByTestId(testId);
  console.log(`menu item ${testId}: ${choice ? 'present' : 'missing'}`);
  expect(choice).not.toBeNull();
  fireEvent.click(choice!);
}

it('Copy selection as Markdown gives the selected part as markdown', async () => {
  await pickOverSelection('message-menu-copy-selection-markdown');
  await waitFor(() => expect(texts.length).toBe(1));
  console.log(`markdown=${JSON.stringify(texts[0])}`);
  expect(texts[0]).toBe('[KEY-2321](https://linear.app/wq/issue/KEY-2321) - Finish the **Assistant** link');
});

it('Copy selection keeps the selected link for a rich paste', async () => {
  await pickOverSelection('message-menu-copy-selection');
  await waitFor(() => expect(items.length).toBe(1));
  const html = await items[0][0].parts['text/html']?.text();
  console.log(`html=${html}`);
  expect(html).toContain('<a href="https://linear.app/wq/issue/KEY-2321"');
  expect(html).toContain('<strong>Assistant</strong>');
});
