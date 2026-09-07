/**
 * A file named anywhere in an agent's own message is drawn as a file.
 *
 * Where it was written must not change what it is: the same name in a sentence,
 * quoted in backticks, and shown in a fenced block is the same file, and the
 * block is where an agent writes most of them (bw-un8y.1, bw-1e2e.1).
 *
 * Exercised through the renderer a chat actually uses, so the marking step and
 * the drawing step are proved as the one decision they are.
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
  path: (absolute, raw, line) => (
    <PathChip absolute={absolute} raw={raw} line={line} look="badge" />
  ),
});

const say = (text: string, disk: OnDisk = ALL) =>
  render(<MarkdownBody mentions={mentions(disk)}>{text}</MarkdownBody>);

describe('a file named in a message', () => {
  it('is a badge when it was named in a sentence', () => {
    say('The fix is in src/workbench/paths.ts and nowhere else.');
    const chip = screen.getByTestId('path-chip');
    expect(chip).toHaveAttribute('data-path-look', 'badge');
    expect(chip).toHaveAttribute('data-path-mention', '/home/someone/project/src/workbench/paths.ts');
    // Drawn as the kind of file it is, the same way a markdown file link is.
    expect(chip).toHaveAttribute('data-file-kind', 'code');
  });

  it('keeps the words the writer wrote, line and all', () => {
    say('See src/workbench/paths.ts:42 for the rule.');
    const chip = screen.getByTestId('path-chip');
    expect(chip).toHaveTextContent('src/workbench/paths.ts:42');
    expect(chip).toHaveAttribute('data-path-line', '42');
  });

  it('is a badge when the sentence quoted it and nothing else', () => {
    say('It went to `/home/someone/project/notes.md` in the end.');
    expect(screen.getByTestId('path-chip')).toHaveAttribute('data-path-look', 'badge');
  });

  it('is a badge inside a command the message quoted', () => {
    say('Run `gh pr create -F /home/someone/project/notes.md` when ready.');
    expect(screen.getByTestId('path-chip')).toHaveAttribute('data-path-look', 'badge');
    // The words around it keep their code: only the name became a chip.
    expect(document.querySelector('code')?.textContent)
      .toBe('gh pr create -F /home/someone/project/notes.md');
  });

  it('is a badge inside a fenced block', () => {
    say('```\ncat /home/someone/project/notes.md\n```');
    const chip = screen.getByTestId('path-chip');
    expect(chip).toHaveAttribute('data-path-look', 'badge');
    expect(chip).toHaveAttribute('data-file-kind', 'text');
  });

  it('is left as words when there is no such file', () => {
    say('Either src/workbench/paths.ts or nothing.', NONE);
    expect(screen.queryByTestId('path-chip')).toBeNull();
  });
});
