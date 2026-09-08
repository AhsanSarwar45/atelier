/**
 * A reference written into a message is drawn as the badge a bare path is
 * drawn as, and carries the lines it asked for.
 *
 * The point of the whole epic is that `@src/a.ts:3-9` means one thing wherever
 * it is written, so this goes through the renderer a chat actually uses: the
 * grammar, the marking step and the drawing step have to agree, and the badge
 * that comes out has to be the SAME badge, not a second kind beside it
 * (bw-gr8y.2).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MarkdownBody, type Mentions } from '@/components/markdown-body';
import { openableIn } from '@/workbench/mentions';
import { PathChip } from '@/workbench/path-chip';
import type { OnDisk, Rooted } from '@/workbench/paths';

const WHERE: Rooted = { cwd: '/home/someone/project', home: '/home/someone' };
/** Everything named here is really there, so shape is all the test is about. */
const ALL: OnDisk = { real: () => true };
const NONE: OnDisk = { real: () => false };

const mentions = (disk: OnDisk): Mentions => ({
  split: (text) => openableIn(text, { card: () => false }, WHERE, disk),
  card: (id) => <span>{id}</span>,
  path: (absolute, raw, line, endLine) => (
    <PathChip absolute={absolute} raw={raw} line={line} endLine={endLine} look="badge" />
  ),
});

const say = (text: string, disk: OnDisk = ALL) =>
  render(<MarkdownBody mentions={mentions(disk)}>{text}</MarkdownBody>);

describe('a reference in a message', () => {
  it('is one badge carrying the first line and the range', () => {
    say('Look at @src/a.ts:3-9 and tell me what it does.');
    const chips = screen.getAllByTestId('path-chip');
    expect(chips).toHaveLength(1);
    const [chip] = chips;
    expect(chip).toHaveAttribute('data-path-look', 'badge');
    expect(chip).toHaveAttribute('data-path-mention', '/home/someone/project/src/a.ts');
    expect(chip).toHaveAttribute('data-path-line', '3');
    expect(chip).toHaveAttribute('data-path-range', '3-9');
    // Drawn in our own form, without the `@`: the badge already says it is a
    // file, so the marker would only be noise.
    expect(chip).toHaveTextContent('src/a.ts:3-9');
  });

  it('has no range when it named a single line', () => {
    say('It is at @src/a.ts:12.');
    const chip = screen.getByTestId('path-chip');
    expect(chip).toHaveAttribute('data-path-line', '12');
    expect(chip).not.toHaveAttribute('data-path-range');
    expect(chip).toHaveTextContent('src/a.ts:12');
  });

  it('has neither when it named the file alone', () => {
    say('Read @src/a.ts before you start.');
    const chip = screen.getByTestId('path-chip');
    expect(chip).not.toHaveAttribute('data-path-line');
    expect(chip).not.toHaveAttribute('data-path-range');
  });

  it("draws the form somebody else's tool wrote in our own form", () => {
    say('Pasted: @src/a.ts#L3-L9 from the editor.');
    const chip = screen.getByTestId('path-chip');
    expect(chip).toHaveTextContent('src/a.ts:3-9');
    expect(chip).toHaveAttribute('data-path-range', '3-9');
  });

  it('draws a folder as the folder it is', () => {
    say('Everything under @src/workbench/ changed.');
    const chip = screen.getByTestId('path-chip');
    expect(chip).toHaveAttribute('data-path-mention', '/home/someone/project/src/workbench');
    expect(chip).toHaveTextContent('src/workbench/');
    expect(chip).not.toHaveAttribute('data-path-line');
  });

  it('finds every reference in the sentence', () => {
    say('Compare @src/a.ts:3-9 with @src/b.ts:20.');
    expect(screen.getAllByTestId('path-chip')).toHaveLength(2);
  });

  it('is left as words when there is no such file', () => {
    say('Look at @src/a.ts:3-9 and tell me.', NONE);
    expect(screen.queryByTestId('path-chip')).toBeNull();
  });

  it('leaves an email address alone', () => {
    say('Ask someone@example.com about it.');
    expect(screen.queryByTestId('path-chip')).toBeNull();
  });
});
