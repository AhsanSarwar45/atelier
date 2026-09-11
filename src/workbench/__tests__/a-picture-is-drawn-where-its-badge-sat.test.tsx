/**
 * A sent message draws each picture where its badge sat in the writing box
 * (bw-oamr.2).
 *
 * Every picture used to be pinned above the words in one grid, whatever the
 * person had written around it, and the only trace of where it belonged was the
 * app's own `[Image: name]` prose left behind in the sentence. That prose is
 * what the transcript then read back to decide whose words these were, which is
 * how an image-first message came to be hidden outright (bw-oamr.1). The
 * position travels as a number on the picture now, so the words are only the
 * person's words and the picture is drawn in its place.
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

/** Everything the row drew, in order, as either a picture's name or its words. */
function inOrder(container: HTMLElement): string[] {
  const drawn: string[] = [];
  for (const node of Array.from(container.querySelectorAll('[data-testid="message-image"], p'))) {
    if (node.getAttribute('data-testid') === 'message-image') drawn.push(`<${node.getAttribute('alt')}>`);
    else if (node.textContent?.trim()) drawn.push(node.textContent.trim());
  }
  return drawn;
}

describe('a picture with a place', () => {
  it('is drawn before the words when it was attached before them', () => {
    const { container } = draw(sent('what is wrong with this?', [shot('shot.png', 0)]));
    expect(inOrder(container)).toEqual(['<shot.png>', 'what is wrong with this?']);
  });

  it('is drawn after the words when it was attached after them', () => {
    const text = 'look at this';
    const { container } = draw(sent(text, [shot('shot.png', text.length)]));
    expect(inOrder(container)).toEqual(['look at this', '<shot.png>']);
  });

  it('is drawn between the words it sat between', () => {
    const text = 'before  after';
    const { container } = draw(sent(text, [shot('shot.png', 7)]));
    expect(inOrder(container)).toEqual(['before', '<shot.png>', 'after']);
  });

  it('keeps two pictures in the order their badges were in', () => {
    const text = 'first  then second  done';
    const { container } = draw(sent(text, [shot('one.png', 6), shot('two.png', 18)]));
    expect(inOrder(container)).toEqual(['first', '<one.png>', 'then second', '<two.png>', 'done']);
  });

  it('draws a picture that sits exactly where a fenced block begins', () => {
    // An inclusive span end is what saves this one: with two half-open spans
    // either side of the block the picture fell down the gap between them and
    // was drawn nowhere at all.
    const text = 'look\n```\ncode\n```\n';
    const { container } = draw(sent(text, [shot('shot.png', text.indexOf('```'))]));
    expect(screen.getByAltText('shot.png')).toBeTruthy();
  });
});

describe('a picture with no place', () => {
  it('is drawn above the words, the way every picture used to be', () => {
    // A chat this app only follows, or a message recorded before any of this.
    const { container } = draw(sent('read this back', [shot('shot.png')]));
    expect(inOrder(container)).toEqual(['<shot.png>', 'read this back']);
    // And it is in the grid above the message, not spliced into the sentence.
    const grids = container.querySelectorAll('[data-testid="picture-grid"]');
    expect(grids).toHaveLength(1);
    expect(within(grids[0] as HTMLElement).getByAltText('shot.png')).toBeTruthy();
  });

  it('goes back above the words when its offset cannot be trusted', () => {
    // A proposed plan is taken out of the drawn text, which moves everything
    // after it — the offset no longer points where it did. Declining to place
    // it must not be the same as dropping it: deciding that in two places, once
    // for the grid and once for the words, is exactly how a picture came to be
    // filtered out of both and drawn nowhere at all.
    const text = '<proposed_plan>do the thing</proposed_plan>after the plan';
    const { container } = draw(sent(text, [shot('shot.png', text.length)]));
    expect(screen.getByAltText('shot.png')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="picture-grid"]')).toHaveLength(1);
  });
});
