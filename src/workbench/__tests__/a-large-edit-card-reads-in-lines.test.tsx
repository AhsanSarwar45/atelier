/**
 * A large edit is read in lines, and the changed ones are drawn.
 *
 * What this replaces: the card said "53,935 characters hidden" and drew no
 * code, because the wire had cut the text to its first four thousand
 * characters — the top of the file, not the change. The wire now works the
 * diff out before that cut, and the card reads +X −Y and draws the hunks
 * (bw-vl3q.3).
 */
import { render, screen } from '@testing-library/react';
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
