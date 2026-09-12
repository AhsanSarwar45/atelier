/**
 * An attachment in a sent message wears the same chip the writing box gives it
 * (bw-oamr.4).
 *
 * The writing box draws an attachment twice and on purpose: a thumbnail in the
 * tray above, and a chip inline at the point in the sentence where it was
 * attached. A sent message drew the thumbnail and not the chip, and in the
 * chip's place stood the app's own `[Image: name]` words. That prose was also
 * what the transcript read back to decide whose words a message was, which is
 * how an image-first message came to be hidden outright (bw-oamr.1).
 *
 * So the prose is gone, the position travels as a number on the picture, and
 * the chip is drawn from it. The grid above is untouched: the chip is an
 * addition to the message, never a replacement for the picture.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { TranscriptRow } from '@/workbench/transcript-rows';
import type { TranscriptItem } from '@/workbench/fold';
import type { ImagePayload } from '@/workbench/protocol';
import type { Mentions } from '@/components/markdown-body';

/** Words drawn as words: nothing in these messages is a path or a card. */
const PLAINLY: Mentions = { split: (text) => [{ kind: 'text', text }], card: () => null };

const SHOT = 'data:image/png;base64,iVBORw0KGgo=';
const shot = (alt: string, at?: number): ImagePayload => ({ mime: 'image/png', dataUrl: SHOT, alt, ...(at === undefined ? {} : { at }) });

const sent = (text: string, images: ImagePayload[]): TranscriptItem => ({
  kind: 'message',
  id: 'sent',
  role: 'user',
  text,
  images,
  done: true,
  parentId: null,
  composedHere: true,
});

const draw = (item: TranscriptItem) =>
  render(<TranscriptRow item={item} sessionId="chat-1" mentions={PLAINLY} onLook={() => {}} />);

/**
 * What the message drew, in order, as either a chip's name or its words.
 *
 * A walk rather than a query, because a chip sits *inside* the sentence now —
 * the same paragraph, between two runs of text — which is the whole point of
 * it. Asking for the chips and the paragraphs separately would put every chip
 * after every word and prove nothing about where it sat.
 */
function inOrder(container: HTMLElement): string[] {
  const drawn: string[] = [];
  let words = '';
  const keep = () => {
    if (words.trim()) drawn.push(words.trim());
    words = '';
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      words += node.textContent ?? '';
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.testid === 'message-attachment-badge') {
      keep();
      drawn.push(`<${node.textContent?.trim()}>`);
      return;
    }
    // The pictures above the words are their own thing and are asserted on
    // their own; they are not part of the sentence being read here.
    if (node.dataset.testid === 'attachment-grid') return;
    for (const kid of Array.from(node.childNodes)) walk(kid);
  };
  walk(container.querySelector('[data-testid="user-message"]')!);
  keep();
  return drawn;
}

describe('an attachment with a place', () => {
  it('wears a chip before the words when it was attached before them', () => {
    const { container } = draw(sent('what is wrong with this?', [shot('shot.png', 0)]));
    expect(inOrder(container)).toEqual(['<shot.png>', 'what is wrong with this?']);
  });

  it('wears a chip after the words when it was attached after them', () => {
    const text = 'look at this';
    const { container } = draw(sent(text, [shot('shot.png', text.length)]));
    expect(inOrder(container)).toEqual(['look at this', '<shot.png>']);
  });

  it('wears a chip between the words it sat between', () => {
    const { container } = draw(sent('before  after', [shot('shot.png', 7)]));
    expect(inOrder(container)).toEqual(['before', '<shot.png>', 'after']);
  });

  it('keeps two chips in the order their badges were in', () => {
    const text = 'first  then second  done';
    const { container } = draw(sent(text, [shot('one.png', 6), shot('two.png', 18)]));
    expect(inOrder(container)).toEqual(['first', '<one.png>', 'then second', '<two.png>', 'done']);
  });

  it('draws a chip that sits exactly where a fenced block begins', () => {
    // An inclusive span end is what saves this one: with two half-open spans
    // either side of the block the chip fell down the gap between them.
    const text = 'look\n```\ncode\n```\n';
    draw(sent(text, [shot('shot.png', text.indexOf('```'))]));
    expect(screen.getAllByTestId('message-attachment-badge')).toHaveLength(1);
  });

  it('leaves the picture in the grid above, chip or no chip', () => {
    // The chip says where it was attached; the picture is still the picture.
    // Drawing one instead of the other is what made the owner ask twice.
    const { container } = draw(sent('look at this', [shot('shot.png', 0)]));
    const grid = container.querySelector('[data-testid="attachment-grid"]')!;
    expect(within(grid as HTMLElement).getByAltText('shot.png')).toBeTruthy();
    expect(screen.getAllByTestId('message-attachment-badge')).toHaveLength(1);
  });

  it('writes no bracketed prose into his words', () => {
    const { container } = draw(sent('look at this', [shot('shot.png', 0)]));
    expect(container.textContent).not.toContain('[Image:');
  });
});

describe('an attachment with no place', () => {
  it('keeps its picture and simply goes without a chip', () => {
    // A chat this app only follows, or a message recorded before any of this.
    const { container } = draw(sent('read this back', [shot('shot.png')]));
    const grid = container.querySelector('[data-testid="attachment-grid"]')!;
    expect(within(grid as HTMLElement).getByAltText('shot.png')).toBeTruthy();
    expect(screen.queryAllByTestId('message-attachment-badge')).toHaveLength(0);
  });

  it('keeps its picture when the offset cannot be trusted', () => {
    // A proposed plan is taken out of the drawn text, which moves everything
    // after it. Going without the chip is fine; losing the picture is not.
    const text = '<proposed_plan>do the thing</proposed_plan>after the plan';
    const { container } = draw(sent(text, [shot('shot.png', text.length)]));
    const grid = container.querySelector('[data-testid="attachment-grid"]')!;
    expect(within(grid as HTMLElement).getByAltText('shot.png')).toBeTruthy();
    expect(screen.queryAllByTestId('message-attachment-badge')).toHaveLength(0);
  });
});
