/**
 * Copying out of a diff copies a reference, not the code (bw-gr8y.8).
 *
 * The point of the feature is the paste that comes after: a reader who has
 * just read three lines of a diff wants to say "these lines" to the agent, and
 * `@src/a.ts:12-14` is how this app says that everywhere (`references.ts`). So
 * what is asked here is what lands on the clipboard for a selection over the
 * new side, a selection over nothing but removed lines, and a press of the
 * button that offers the lines themselves after all.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

describe('copying out of a diff', () => {
  it('writes a reference to the lines the selection covered', () => {
    render(<DiffTable rows={rows} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');
    selectRows(table, 2, 4);
    expect(copyFrom(table)).toBe('@src/a.ts:12-14');
  });

  it('names one line when only one was selected', () => {
    render(<DiffTable rows={rows} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');
    selectRows(table, 2, 2);
    expect(copyFrom(table)).toBe('@src/a.ts:12');
  });

  it('counts a selection over removed lines by the old numbers', () => {
    render(<DiffTable rows={removals} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');
    selectRows(table, 0, 1);
    expect(copyFrom(table)).toBe('@src/a.ts:12-13');
  });

  it('leaves the copy alone in a table that does not know its file', () => {
    render(<DiffTable rows={rows} language="typescript" />);
    const table = screen.getByTestId('diff-table');
    selectRows(table, 2, 4);
    expect(copyFrom(table)).toBeUndefined();
  });

  it('offers the lines themselves on a button beside the selection', async () => {
    const written = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: written }, configurable: true });

    render(<DiffTable rows={rows} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');
    expect(screen.queryByTestId('diff-copy-text')).toBeNull();

    selectRows(table, 2, 4);
    const offer = screen.getByTestId('diff-copy-text');
    expect(offer.textContent).toContain('Copy text');
    fireEvent.click(offer.querySelector('button')!);
    // The new side's lines, in the order they are read, and nothing else.
    expect(written).toHaveBeenCalledWith('const twelve = 12;\nconst fresh = 13;\nconst fourteen = 14;');
  });
});
