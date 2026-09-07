/**
 * The shared diff table draws the rows it is handed and nothing else.
 *
 * The edit card and the git diff work their rows out in quite different ways;
 * what makes them look like one thing is that both end up here. So this asks
 * the table only what a reader can see: the numbers down each side, the row's
 * own kind on the row, and the gap standing in for lines nobody sent
 * (bw-rx1y.3).
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DiffTable } from '@/workbench/diff-table';
import { hunksToRows, type DiffHunk } from '@/workbench/line-diff';

const hunks: DiffHunk[] = [
  {
    oldStart: 10,
    oldLines: 2,
    newStart: 10,
    newLines: 2,
    lines: [
      { kind: 'context', text: 'const before = 1;' },
      { kind: 'removed', text: 'const changed = 2;' },
      { kind: 'added', text: 'const changed = 3;' },
    ],
  },
  {
    oldStart: 30,
    oldLines: 0,
    newStart: 30,
    newLines: 1,
    lines: [{ kind: 'added', text: 'const appended = 4;' }],
  },
];

describe('the diff table', () => {
  it('draws a line number down each side', () => {
    const { container } = render(<DiffTable rows={hunksToRows(hunks)} language="typescript" />);
    const gutters = [...container.querySelectorAll('tr')].map((tr) => {
      const cells = [...tr.querySelectorAll('td')];
      return cells.length === 4 ? [cells[0]!.textContent, cells[2]!.textContent] : null;
    });
    // The context line is old ten and new ten; the second hunk's addition is
    // new line thirty and nothing on the left.
    expect(gutters).toEqual([['10', '10'], ['11', '11'], null, ['', '30']]);
  });

  it('says on each row what kind of row it is', () => {
    const { container } = render(<DiffTable rows={hunksToRows(hunks)} language="typescript" />);
    expect([...container.querySelectorAll('tr')].map((tr) => tr.getAttribute('data-diff-kind'))).toEqual([
      'same',
      'changed',
      'gap',
      'added',
    ]);
  });

  it('stands one full-width row in for the lines it was not sent', () => {
    const { container } = render(<DiffTable rows={hunksToRows(hunks)} language="typescript" />);
    const gap = container.querySelector('tr[data-diff-kind="gap"]')!;
    expect(gap.textContent).toBe('18 unchanged lines');
    expect(gap.querySelector('td')).toHaveAttribute('colspan', '4');
  });

  it('writes the one line it left out in the singular', () => {
    const { container } = render(
      <DiffTable rows={[{ left: null, right: null, kind: 'gap', count: 1 }]} language={null} />,
    );
    expect(container.querySelector('tr[data-diff-kind="gap"]')!.textContent).toBe('1 unchanged line');
  });

  it('leaves the gutter empty on the side a row has nothing on', () => {
    const { container } = render(<DiffTable rows={hunksToRows(hunks)} language="typescript" />);
    const added = container.querySelector('tr[data-diff-kind="added"]')!;
    const cells = [...added.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells).toEqual(['', '', '30', 'const appended = 4;']);
  });
});
