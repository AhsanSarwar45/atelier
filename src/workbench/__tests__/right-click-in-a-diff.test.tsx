/**
 * Copying out of a diff copies the lines of one side, and a right-click opens
 * a menu whose "Copy reference" names them as `@diff:src/a.ts:+12-14` — what
 * the composer draws as a badge that opens the diff at those lines
 * (bw-v79ny.2). Asked here: what Ctrl+C writes, what the reference names for
 * a selection over the new side, over removed lines only, and over no
 * selection at all, and that a commit's diff names its commit.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DiffTable } from '@/workbench/diff-table';
import type { DiffRow } from '@/workbench/line-diff';

/** A file whose lines ten to sixteen are untouched, with one line rewritten. */
const rows: DiffRow[] = [
  { left: 'const ten = 10;', right: 'const ten = 10;', kind: 'same', leftNo: 10, rightNo: 10 },
  { left: 'const eleven = 11;', right: 'const eleven = 11;', kind: 'same', leftNo: 11, rightNo: 11 },
  { left: 'const twelve = 12;', right: 'const twelve = 12;', kind: 'same', leftNo: 12, rightNo: 12 },
  { left: 'const old = 13;', right: 'const fresh = 13;', kind: 'changed', leftNo: 13, rightNo: 13 },
  { left: 'const fourteen = 14;', right: 'const fourteen = 14;', kind: 'same', leftNo: 14, rightNo: 14 },
];

/** Only lines the old file had: the rows a deletion leaves behind. */
const removals: DiffRow[] = [
  { left: 'const gone = 12;', right: null, kind: 'removed', leftNo: 12 },
  { left: 'const also = 13;', right: null, kind: 'removed', leftNo: 13 },
];

/** Drag over the rows from `first` to `last`, counting them as they are drawn. */
function selectRows(table: HTMLElement, first: number, last: number) {
  const drawn = [...table.querySelectorAll('tr')];
  const range = document.createRange();
  range.setStart(drawn[first]!, 0);
  range.setEnd(drawn[last]!, drawn[last]!.childNodes.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => document.dispatchEvent(new Event('selectionchange')));
}

/** The copy a reader presses, and what it was handed for `text/plain`. */
function copyFrom(table: HTMLElement): string | undefined {
  const written: Record<string, string> = {};
  const event = Object.assign(new Event('copy', { bubbles: true, cancelable: true }), {
    clipboardData: { setData: (kind: string, value: string) => void (written[kind] = value) },
  });
  table.dispatchEvent(event);
  return written['text/plain'];
}

let written = vi.fn();
beforeEach(() => {
  written = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: written }, configurable: true });
});

/** A right-click on `on`, then the item `item`: what the clipboard was handed. */
function fromMenu(on: Element, item: string): string | undefined {
  fireEvent.contextMenu(on, { clientX: 10, clientY: 10 });
  fireEvent.click(screen.getByTestId(item));
  return written.mock.calls.at(-1)?.[0] as string | undefined;
}

describe('copying out of a diff', () => {
  it('copies the lines of the new side, as the file has them', () => {
    render(<DiffTable rows={rows} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');
    selectRows(table, 2, 4);
    expect(copyFrom(table)).toBe('const twelve = 12;\nconst fresh = 13;\nconst fourteen = 14;');
  });

  it('leaves the copy alone in a table that does not know its file', () => {
    render(<DiffTable rows={rows} language="typescript" />);
    const table = screen.getByTestId('diff-table');
    selectRows(table, 2, 4);
    expect(copyFrom(table)).toBeUndefined();
  });

  it('has no floating button beside a selection', () => {
    render(<DiffTable rows={rows} language="typescript" path="src/a.ts" />);
    selectRows(screen.getByTestId('diff-table'), 2, 4);
    expect(screen.queryByTestId('diff-copy-text')).toBeNull();
  });
});

describe('the menu a right-click in a diff opens', () => {
  it('names the selected lines as a diff reference', () => {
    render(<DiffTable rows={rows} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');
    selectRows(table, 2, 4);
    expect(fromMenu(table, 'diff-menu-copy-reference')).toBe('@diff:src/a.ts:+12-14');
  });

  it('names one line when only one was selected, and the file the same way', () => {
    render(<DiffTable rows={rows} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');
    selectRows(table, 2, 2);
    expect(fromMenu(table, 'diff-menu-copy-reference')).toBe('@diff:src/a.ts:+12');
    selectRows(table, 2, 2);
    expect(fromMenu(table, 'diff-menu-copy-file-reference')).toBe('@src/a.ts:12');
  });

  it('counts removed lines on the old side, and offers no file reference for them', () => {
    render(<DiffTable rows={removals} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');
    selectRows(table, 0, 1);
    expect(fromMenu(table, 'diff-menu-copy-reference')).toBe('@diff:src/a.ts:-12-13');
    selectRows(table, 0, 1);
    fireEvent.contextMenu(table, { clientX: 10, clientY: 10 });
    expect(screen.queryByTestId('diff-menu-copy-file-reference')).toBeNull();
  });

  it('names the line under the pointer when nothing is selected, on the side it is on', () => {
    window.getSelection()!.removeAllRanges();
    render(<DiffTable rows={rows} language="typescript" path="src/a.ts" />);
    const changed = screen.getByTestId('diff-table').querySelectorAll('tr')[3]!;
    expect(fromMenu(changed.cells[1]!, 'diff-menu-copy-reference')).toBe('@diff:src/a.ts:-13');
    expect(fromMenu(changed.cells[3]!, 'diff-menu-copy-reference')).toBe('@diff:src/a.ts:+13');
  });

  it("names a commit's diff by the commit, short", () => {
    render(<DiffTable rows={rows} language="typescript" path="src/a.ts" commit="abc1234def5678" />);
    const table = screen.getByTestId('diff-table');
    selectRows(table, 2, 4);
    expect(fromMenu(table, 'diff-menu-copy-reference')).toBe('@diff:abc1234:src/a.ts:+12-14');
  });

  it('copies the selected lines, and collapses the file', () => {
    const collapse = vi.fn();
    render(<DiffTable rows={rows} language="typescript" path="src/a.ts" onCollapse={collapse} />);
    const table = screen.getByTestId('diff-table');
    selectRows(table, 2, 4);
    expect(fromMenu(table, 'diff-menu-copy')).toBe('const twelve = 12;\nconst fresh = 13;\nconst fourteen = 14;');
    fireEvent.contextMenu(table, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId('diff-menu-collapse'));
    expect(collapse).toHaveBeenCalled();
  });

  it('is the browser\'s own menu in a table that does not know its file', () => {
    render(<DiffTable rows={rows} language="typescript" />);
    fireEvent.contextMenu(screen.getByTestId('diff-table'));
    expect(screen.queryByTestId('diff-menu')).toBeNull();
  });
});
