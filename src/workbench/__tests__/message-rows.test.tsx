/**
 * A sentence in a conversation is findable, and sits on its own side.
 *
 * Two faults, both of them the manager's: every message wore the violet rail
 * that means a HELPER wrote it, because the rail was applied whenever the call
 * it came from was not exactly null and a row folded from a chat's record
 * carries no such field at all — and the indent the rail adds beat the margin
 * holding his words to the right, so his messages moved to the wrong end of the
 * page (bw-jkh2.15). The other is that a tint alone did not carry far enough
 * down a page of commands to find a sentence by (bw-jkh2.16).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import type { LookableImage } from '@/workbench/protocol';
import { TranscriptRow } from '@/workbench/transcript-rows';
import type { TranscriptItem } from '@/workbench/use-session';

const MENTIONS: Mentions = { split: (text) => [{ kind: 'text', text }], card: (id) => id };
const LOOK = (_image: LookableImage) => {};

/** One message, said by whoever, from wherever. */
const said = (
  role: 'user' | 'assistant',
  text: string,
  parentId: string | null | undefined = null,
): TranscriptItem =>
  ({ kind: 'message', id: `m-${role}-${text}`, role, text, images: [], done: true, parentId }) as TranscriptItem;

const draw = (item: TranscriptItem) =>
  render(<TranscriptRow item={item} sessionId="s" mentions={MENTIONS} onLook={LOOK} />);

describe('a message says who said it', () => {
  it('holds his own words to the right and gives the answer the column', () => {
    draw(said('user', 'do the thing'));
    draw(said('assistant', 'done'));
    const mine = screen.getByTestId('user-message').className;
    const its = screen.getByTestId('assistant-message').className;
    expect(mine).toContain('ml-auto');
    expect(mine).toContain('max-w-');
    // The answer takes the column by being left to fill it, and never by being
    // told to be the whole of it: a width of 100% is measured from the frame
    // rather than from where the message starts, so an indented one reached
    // past the right edge and gave the chat a sideways scrollbar (bw-n6yh.14).
    expect(its).not.toContain('w-full');
    expect(its).not.toContain('max-w-');
    expect(its).not.toContain('ml-auto');
  });

  it('marks the two differently, so a sentence is findable among the commands', () => {
    draw(said('user', 'do the thing'));
    draw(said('assistant', 'done'));
    const mine = screen.getByTestId('user-message').className;
    const its = screen.getByTestId('assistant-message').className;
    // His on the left, the agent's on the right (bw-jkh2.18).
    expect(mine).toContain('border-l-2');
    expect(its).toContain('border-r-2');
    // Each edge in its own colour, and neither of them the helper's violet.
    expect(mine).toContain('border-primary/70');
    expect(its).toContain('border-muted-foreground/40');
    expect(mine).not.toContain('violet');
    expect(its).not.toContain('violet');
  });
});

describe('the rail that means a helper wrote it', () => {
  it('is not worn by a row whose call was never written down', () => {
    // What a chat read back from its own record looks like: the field is
    // missing, not empty.
    draw(said('user', 'do the thing', undefined));
    const row = screen.getByTestId('user-message');
    expect(row.className).not.toContain('violet');
    expect(row.className).toContain('ml-auto');
  });

  it('is worn by a row a helper really did produce', () => {
    draw(said('assistant', 'the helper reporting back', 'call-1'));
    expect(screen.getByTestId('assistant-message').className).toContain('violet');
  });
});
