/**
 * A long diff draws a screenful of itself, and a copy still names the right
 * lines (bw-o5i3.3).
 *
 * The table drew a row for every line in the file, and coloured both sides
 * whole on every render while the panel around it re-read itself every five
 * seconds. A 10,000-row diff was 150,011 nodes, 2,430 ms to appear and 597 ms
 * to redraw; even 2,000 rows — which is where a file stops opening itself —
 * was 30,011 nodes and 537 ms.
 *
 * The thing most at risk in windowing a table is the copy. A selection used to
 * be read off each row's position in the tbody, which is no longer the row's
 * place in the file once two spacer rows are holding the scroll open, so the
 * case below selects inside a windowed table and asks what a copy names.
 */
import { act, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';

import { DiffTable } from '@/workbench/diff-table';
import type { DiffRow } from '@/workbench/line-diff';

/**
 * jsdom has no layout, so every box is nought high — and a virtualiser told
 * its viewport is nought high draws no rows at all.
 */
beforeAll(() => {
  for (const [side, size] of [['offsetHeight', 800], ['clientHeight', 800], ['offsetWidth', 900], ['clientWidth', 900]] as const) {
    Object.defineProperty(HTMLElement.prototype, side, { configurable: true, get: () => size });
  }
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 900, height: 800, top: 0, left: 0, right: 900, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  HTMLElement.prototype.scrollTo = () => {};
});

/** A file of `howMany` lines, every seventh of them rewritten. */
function fileOf(howMany: number): DiffRow[] {
  return Array.from({ length: howMany }, (_, at) => ({
    kind: at % 7 === 0 ? 'changed' : 'same',
    left: `const named${at} = compute(${at});`,
    right: `const named${at} = compute(${at % 7 === 0 ? at + 1 : at});`,
    leftNo: at + 1,
    rightNo: at + 1,
  })) as unknown as DiffRow[];
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

describe('a diff of thousands of lines', () => {
  it('draws a window of rows, not one per line', () => {
    const began = performance.now();
    render(<DiffTable rows={fileOf(10_000)} language="typescript" path="src/a.ts" />);
    const took = performance.now() - began;

    expect(screen.getByTestId('diff-pane').dataset.drawn).toBe('window');
    const drawn = document.querySelectorAll('tr[data-row-at]').length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(200);
    expect(document.querySelectorAll('*').length).toBeLessThan(4_000);
    expect(took).toBeLessThan(1_000);
  }, 60_000);

  it('still names the lines a selection covered', () => {
    render(<DiffTable rows={fileOf(10_000)} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');

    // Three drawn rows in the middle of the window, whatever their place in
    // the file happens to be — which is the whole point: the row says.
    const lines = [...table.querySelectorAll<HTMLElement>('tr[data-row-at]')];
    const from = lines[2]!;
    const to = lines[4]!;
    const range = document.createRange();
    range.setStart(from, 0);
    range.setEnd(to, to.childNodes.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    act(() => document.dispatchEvent(new Event('selectionchange')));

    const first = Number(from.dataset.rowAt) + 1;
    const last = Number(to.dataset.rowAt) + 1;
    expect(copyFrom(table)).toBe(`@src/a.ts:${first}-${last}`);
  }, 60_000);

  it('leaves an ordinary diff drawn whole', () => {
    render(<DiffTable rows={fileOf(40)} language="typescript" path="src/a.ts" />);

    expect(screen.getByTestId('diff-pane').dataset.drawn).toBe('all');
    expect(document.querySelectorAll('tr[data-row-at]')).toHaveLength(40);
  });
});
