/**
 * A long diff draws a screenful of itself, and a copy still names the right
 * lines (bw-o5i3.3).
 *
 * The table drew a row for every line in the file, and coloured both sides
 * whole on every render while the panel around it re-read itself every five
 * seconds. Opened in a browser, an un-windowed table cost one long task of
 * 97 ms at 802 rows, 245 ms at 2,002 and 433 ms at 10,002, drawing 7,599,
 * 18,399 and 50,399 nodes; nothing else on the screen answers meanwhile.
 *
 * The thing most at risk in windowing a table is the copy. A selection used to
 * be read off each row's position in the tbody, which is no longer the row's
 * place in the file once two spacer rows are holding the scroll open, so the
 * cases below select inside a windowed table and ask what a copy names: once
 * at the top, once after scrolling far enough that the drawn rows are nowhere
 * near their old positions, and once while the drag runs past what is drawn.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

/**
 * The real selection, kept before any stand-in is put in front of it.
 *
 * Every box on this bench measures the one height the stub gives, rows
 * included, so a row is 800 tall here and a scroll has to be counted in
 * hundreds of thousands to land anywhere interesting.
 */
const realSelection = window.getSelection.bind(window);

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

/** Where a row sits in the tbody, counting the spacer that holds the top open. */
function placeInBody(row: HTMLElement): number {
  return [...(row.closest('tbody')?.rows ?? [])].indexOf(row as HTMLTableRowElement) + 1;
}

/**
 * Put the box `down` pixels down and tell it so.
 *
 * jsdom keeps no scroll of its own, so the number has to be hung on the
 * element before the virtualiser is told to look again.
 */
function scrollTo(pane: HTMLElement, down: number): void {
  Object.defineProperty(pane, 'scrollTop', { configurable: true, value: down, writable: true });
  act(() => void pane.dispatchEvent(new Event('scroll')));
}

/**
 * Select from one row to another, optionally keeping the anchor the browser
 * reports — the place the press landed — at a row that has since been taken
 * down. Everything the table reads goes through `window.getSelection`, so a
 * stand-in for it is enough to stage a drag that outran the window.
 */
function select(from: HTMLElement, to: HTMLElement, anchor?: { anchorNode: Node; anchorOffset: number }): void {
  const range = document.createRange();
  range.setStart(from, 0);
  range.setEnd(to, to.childNodes.length);
  const real = realSelection()!;
  real.removeAllRanges();
  real.addRange(range);
  if (anchor) {
    const standIn = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range, ...anchor };
    vi.spyOn(window, 'getSelection').mockReturnValue(standIn as unknown as Selection);
  }
  act(() => document.dispatchEvent(new Event('selectionchange')));
}

describe('a diff of thousands of lines', () => {
  afterEach(() => vi.restoreAllMocks());

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

  it('names the lines a selection covered after the reader has scrolled', () => {
    render(<DiffTable rows={fileOf(10_000)} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');
    scrollTo(screen.getByTestId('diff-pane'), 4_000_000);

    const lines = [...table.querySelectorAll<HTMLElement>('tr[data-row-at]')];
    const from = lines[2]!;
    const to = lines[4]!;

    // The rows are now nowhere near the top of the file, and nowhere near
    // their own place in the tbody either: this is the gap the old counting
    // fell into, so say out loud that the gap is there before trusting it.
    const first = Number(from.dataset.rowAt) + 1;
    expect(first).toBeGreaterThan(1_000);
    expect(placeInBody(from)).not.toBe(first);

    select(from, to);
    expect(copyFrom(table)).toBe(`@src/a.ts:${first}-${Number(to.dataset.rowAt) + 1}`);
  }, 60_000);

  it('names the whole stretch a drag covered, not the part still drawn', () => {
    render(<DiffTable rows={fileOf(10_000)} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');

    // A reader presses on one row and drags down past the bottom of the box.
    // The rows they started on scroll away and are taken down, so the browser
    // hands back a selection whose drawn part is only the tail of the drag —
    // but its anchor, the place the press landed, does not move. That is what
    // the table holds on to, and jsdom will not scroll a live drag, so the
    // selection is the one thing spoken for here.
    const began = [...table.querySelectorAll<HTMLElement>('tr[data-row-at]')];
    const pressed = began[2]!;
    const anchor = { anchorNode: pressed, anchorOffset: 0 };
    select(pressed, began[4]!, anchor);
    const first = Number(pressed.dataset.rowAt) + 1;
    expect(copyFrom(table)).toBe(`@src/a.ts:${first}-${Number(began[4]!.dataset.rowAt) + 1}`);

    scrollTo(screen.getByTestId('diff-pane'), 4_000_000);
    const now = [...table.querySelectorAll<HTMLElement>('tr[data-row-at]')];
    const ended = now[4]!;
    select(now[0]!, ended, anchor);

    expect(copyFrom(table)).toBe(`@src/a.ts:${first}-${Number(ended.dataset.rowAt) + 1}`);
  }, 60_000);

  it('names where a drag came back to, not how far it went', () => {
    // A short diff, where no row is ever taken down: the reference has to be
    // exactly what is highlighted, and it was before a drag was allowed to be
    // remembered at all.
    render(<DiffTable rows={fileOf(40)} language="typescript" path="src/a.ts" />);
    const table = screen.getByTestId('diff-table');
    const lines = [...table.querySelectorAll<HTMLElement>('tr[data-row-at]')];
    const pressed = lines[12]!;
    const anchor = { anchorNode: pressed, anchorOffset: 0 };

    select(pressed, lines[20]!, anchor);
    expect(copyFrom(table)).toBe('@src/a.ts:13-21');

    // Back up the way it came, without letting go.
    select(pressed, lines[14]!, anchor);
    expect(copyFrom(table)).toBe('@src/a.ts:13-15');
  });

  it('leaves an ordinary diff drawn whole', () => {
    render(<DiffTable rows={fileOf(40)} language="typescript" path="src/a.ts" />);

    expect(screen.getByTestId('diff-pane').dataset.drawn).toBe('all');
    expect(document.querySelectorAll('tr[data-row-at]')).toHaveLength(40);
  });
});
