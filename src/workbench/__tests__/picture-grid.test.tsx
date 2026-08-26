/**
 * How the pictures of one message are laid out.
 *
 * Stacked at full bubble width, two screenshots pushed the words off the screen
 * and five were a page of their own. The rule the manager asked for is the one
 * every chat app uses: one keeps its own shape, two and three stand across,
 * four is a square, and past four it is rows of three (bw-uu9x.10).
 *
 * A browser with no layout cannot say where a thumbnail lands on the glass, so
 * what is held still here is the rule — how many stand across, how many rows
 * that makes, and that the block is bounded. Where they actually land is read
 * off the running screen instead (tests/e2e/chat-picture.spec.ts, bw-uu9x.11).
 */
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ImagePayload } from '@/workbench/protocol';

import { PictureGrid, acrossFor } from '../picture-grid';

/** A one-pixel PNG, small enough to write out here in full. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** As many pictures as a message is being said to hold. */
function pictures(count: number): ImagePayload[] {
  return Array.from({ length: count }, (_, i) => ({
    mime: 'image/png',
    dataUrl: PIXEL,
    alt: `Picture ${i + 1}`,
  }));
}

/** What one message of this many pictures draws, on a page of its own. */
function drawn(count: number) {
  cleanup();
  const looked = vi.fn();
  render(<PictureGrid images={pictures(count)} onLook={looked} />);
  const grid = screen.getByTestId('picture-grid');
  return {
    grid,
    looked,
    across: Number(grid.getAttribute('data-across')),
    thumbs: screen.getAllByTestId('message-image'),
  };
}

describe('the rule for laying out one message’s pictures', () => {
  it('puts one on its own, two side by side and three across', () => {
    expect(acrossFor(1)).toBe(1);
    expect(acrossFor(2)).toBe(2);
    expect(acrossFor(3)).toBe(3);
  });

  it('squares four off rather than leaving one trailing under three', () => {
    expect(acrossFor(4)).toBe(2);
  });

  it('goes in threes past four, so five is three then two and six is two rows of three', () => {
    expect(acrossFor(5)).toBe(3);
    expect(acrossFor(6)).toBe(3);
    expect(acrossFor(12)).toBe(3);
  });

  it('never leaves a message a column of pictures a scroll long', () => {
    // Whatever the count, the rows it makes are the count over the width — and
    // that is what stops a dozen screenshots becoming a dozen rows.
    for (const count of [1, 2, 3, 4, 5, 6, 7, 9, 12]) {
      const rows = Math.ceil(count / acrossFor(count));
      expect(rows).toBeLessThanOrEqual(4);
    }
  });
});

describe('a message’s pictures on the page', () => {
  it('draws every picture the message holds, whatever the count', () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7]) {
      const { thumbs, across } = drawn(count);
      expect(thumbs, `${count} pictures`).toHaveLength(count);
      expect(across, `${count} pictures`).toBe(acrossFor(count));
    }
  });

  it('stands them across in the number the rule asks for', () => {
    expect(drawn(5).grid.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
  });

  it('holds the whole block to a width, so no screenshot swallows the message', () => {
    const { grid } = drawn(3);
    expect(grid.className).toContain('max-w-[24rem]');
  });

  it('lets a lone picture keep its own shape and crops the rest to line up', () => {
    const picture = drawn(1).thumbs[0]!;
    expect(picture.className).toContain('object-contain');
    expect(picture.className).not.toContain('aspect-');
    expect(picture).toHaveStyle({
      width: 'auto',
      height: 'auto',
      maxWidth: '100%',
      maxHeight: '24rem',
    });
  });

  it('crops two or more to a common shape, because a ragged row reads as a mess', () => {
    for (const thumb of drawn(4).thumbs) {
      expect(thumb.className).toContain('object-cover');
      expect(thumb.className).toContain('aspect-[4/3]');
    }
  });

  it('opens the picture that was clicked, not the first one', () => {
    const { thumbs, looked } = drawn(5);
    fireEvent.click(thumbs[4]!);
    expect(looked).toHaveBeenCalledWith(expect.objectContaining({ alt: 'Picture 5' }));
  });

  it('draws nothing at all for a message with no pictures in it', () => {
    render(<PictureGrid images={[]} onLook={vi.fn()} />);
    expect(screen.queryByTestId('picture-grid')).toBeNull();
  });
});
