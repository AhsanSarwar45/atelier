/**
 * A large edit is read in lines, and the changed ones are drawn.
 *
 * What this replaces: the card said "53,935 characters hidden" and drew no
 * code, because the wire had cut the text to its first four thousand
 * characters — the top of the file, not the change. The wire now works the
 * diff out before that cut, and the card reads +X −Y and draws the hunks
 * (bw-vl3q.3).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolRow } from '@/workbench/transcript-rows';
import { changeOf } from '@/workbench/line-diff';
import type { TranscriptItem } from '@/workbench/use-session';

const path = '/home/me/project/src/git-view.tsx';
const big = (n: number) => Array.from({ length: n }, (_, at) => `const line${at + 1} = ${at + 1};`).join('\n') + '\n';

/** A whole-file write, as the wire delivers it: text cut, change intact. */
function largeEdit(before: string, after: string): Extract<TranscriptItem, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id: 'edit-1',
    name: 'Write',
    title: `Changed ${path}`,
    status: 'ok',
    seconds: 0,
    summary: null,
    parentId: null,
    input: { file_path: path },
    output: 'The file has been updated.',
    diff: {
      path,
      before: `${before.slice(0, 4000)}\n… and ${before.length - 4000} more characters`,
      after: `${after.slice(0, 4000)}\n… and ${after.length - 4000} more characters`,
      ...changeOf(before, after),
    },
    ranKind: 'edit',
    ranGrave: false,
  };
}

describe('a large edit card', () => {
  const before = big(1500);
  const after = before.replace('const line1400 = 1400;', 'const line1400 = 1401;');

  it('says how many lines changed instead of how many characters are hidden', () => {
    render(<ToolRow item={largeEdit(before, after)} nested={false} />);

    expect(screen.getByTestId('diff-counts')).toHaveTextContent('+1');
    expect(screen.getByTestId('diff-counts')).toHaveTextContent('−1');
    expect(screen.queryByText(/characters hidden/)).toBeNull();
    expect(screen.queryByTestId('diff-summary')).toBeNull();
  });

  it('draws the changed lines and not the top of the file', () => {
    render(<ToolRow item={largeEdit(before, after)} nested={false} />);

    const table = screen.getByTestId('diff-view');
    expect(table).toHaveTextContent('const line1401 = 1401;');
    // Six lines of context each side, so the change is read in its place.
    expect(table).toHaveTextContent('const line1394 = 1394;');
    // And not the first line of the file, which is what the cut text held.
    expect(table).not.toHaveTextContent('const line1 = 1;');
  });

  it('says what it could not draw rather than implying it drew everything', () => {
    const scattered = Array.from({ length: 2000 }, (_, at) => `line ${at + 1}`).join('\n') + '\n';
    const changed = scattered
      .split('\n')
      .map((l, at) => ((at + 1) % 20 === 0 ? `changed ${at + 1}` : l))
      .join('\n');
    render(<ToolRow item={largeEdit(scattered, changed)} nested={false} />);

    expect(screen.getByTestId('diff-omitted')).toHaveTextContent(/more changes not shown/);
  });

  it('still reads in characters for a row stored before the wire counted lines', () => {
    render(<ToolRow item={{
      ...largeEdit(before, after),
      diff: { path, before: 'a', after: `${'b'.repeat(4000)}\n… and 4310 more characters` },
    }} nested={false} />);

    expect(screen.getByTestId('diff-summary')).toHaveTextContent('8,310 characters hidden');
    expect(screen.queryByTestId('diff-counts')).toBeNull();
  });

  it('says a file was written without change rather than drawing nothing', () => {
    render(<ToolRow item={largeEdit(before, before)} nested={false} />);

    expect(screen.getByTestId('diff-counts')).toHaveTextContent('+0');
    expect(screen.getByTestId('diff-summary')).toHaveTextContent('No lines changed');
  });
});

/**
 * A diff worth scrolling is worth putting away. It opens on its first lines
 * and the rest are asked for, rather than a fixed window the reader scrolls
 * inside without ever being told how much is in there (bw-vl3q.4).
 */
describe('a long diff opens and closes', () => {
  // Twenty changed lines in a row, which with context is far past the dozen
  // a card opens on.
  const before = big(200);
  const after = before
    .split('\n')
    .map((l, at) => (at >= 100 && at < 120 ? `const line${at + 1} = 0;` : l))
    .join('\n');

  it('opens on its first lines and says how many there are in all', () => {
    render(<ToolRow item={largeEdit(before, after)} nested={false} />);

    const control = screen.getByTestId('diff-expand');
    expect(control).toHaveTextContent(/Show all \d+ lines/);
    expect(control).toHaveAttribute('aria-expanded', 'false');
    // The first lines are drawn; the last of the change is not, yet.
    expect(screen.getByTestId('diff-view')).toHaveTextContent('const line95 = 95;');
    expect(screen.getByTestId('diff-view')).not.toHaveTextContent('const line126 = 126;');
  });

  it('opens to the whole diff and closes again', () => {
    render(<ToolRow item={largeEdit(before, after)} nested={false} />);
    const control = screen.getByTestId('diff-expand');

    fireEvent.click(control);
    expect(control).toHaveAttribute('aria-expanded', 'true');
    expect(control).toHaveTextContent('Show fewer lines');
    expect(screen.getByTestId('diff-view')).toHaveTextContent('const line126 = 126;');

    fireEvent.click(control);
    expect(control).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('diff-view')).not.toHaveTextContent('const line126 = 126;');
  });

  it('offers nothing to open on a diff already drawn whole', () => {
    const small = big(20);
    render(<ToolRow item={largeEdit(small, small.replace('const line5 = 5;', 'const line5 = 6;'))} nested={false} />);

    expect(screen.queryByTestId('diff-expand')).toBeNull();
    expect(screen.getByTestId('diff-view')).toHaveTextContent('const line5 = 6;');
  });

  it('does not shut the card when the diff is opened', () => {
    render(<ToolRow item={largeEdit(before, after)} nested={false} />);
    fireEvent.click(screen.getByTestId('diff-expand'));
    expect(screen.getByTestId('tool-row')).toHaveAttribute('data-open', 'true');
  });

  it('draws one enormous line only so far, and says how much it left out', () => {
    const line = 'QUJD'.repeat(50_000);
    render(<ToolRow item={largeEdit('', `${line}\n`)} nested={false} />);

    const table = screen.getByTestId('diff-view');
    expect(table).toHaveTextContent('199,500 more characters');
    expect(table.textContent!.length).toBeLessThan(2_000);
  });
});
