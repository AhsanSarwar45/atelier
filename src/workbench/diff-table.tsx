/**
 * The one table that draws a diff, wherever the rows came from.
 *
 * The edit card works its rows out from the before and after text it was
 * handed; the git diff gets them from the hunks the server parsed. Neither
 * knows anything about the other, and both are drawn here, so a change to how
 * a removed line looks is one change (bw-rx1y.3).
 *
 * A table that knows which file it is showing also answers a copy with a
 * reference — `@src/a.ts:12-14` — rather than with the lines, so that reading a
 * diff and then pointing the agent at what you read is one gesture and not a
 * retyped path (bw-gr8y.8). The reader who wanted the code after all takes it
 * from the floating "Copy text" button the selection raises.
 *
 * On a phone the same rows are stacked into one column instead — see
 * `STACKED_ROW` — because two columns of code at 390px are two columns nobody
 * can read (bw-e3dw.3).
 *
 * Design: docs/agent-workbench.md §8.2.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';
import { Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { paintLines } from '@/workbench/colouring';
import type { DiffRow } from '@/workbench/line-diff';
import { formatReference } from '@/workbench/references';
import { Line } from '@/workbench/split-paths';

/** What a copy out of a diff can put on the clipboard: either of the two. */
export interface CopiedDiff {
  /** Our own form, `@path:12-14`, over the lines the selection touched. */
  reference: string;
  /** Those same lines as they are written in the file. */
  text: string;
}

/**
 * What a selection over these rows means, as a reference and as lines.
 *
 * A selection is read by ROW and not by cell, because a browser has no notion
 * of a column: dragging down the left-hand side of a table takes everything
 * between the two ends in document order, right-hand cells included. So the
 * side is chosen by what the touched rows actually carry — the new numbers when
 * any of the rows has one, which is the card's rule for a selection over both
 * sides, and the old numbers when none does, which is a selection over nothing
 * but removed lines.
 *
 * Rows the selection only skipped over — the gaps standing in for unsent lines
 * — carry no line of their own and are left out of both answers.
 */
export function copiedFromRows(rows: DiffRow[], path: string): CopiedDiff | null {
  const touched = rows.filter((r) => r.kind !== 'gap');
  const side = touched.some((r) => r.right !== null && r.rightNo) ? 'right' : 'left';
  const lines = touched
    .map((r) => (side === 'right' ? { no: r.rightNo, text: r.right } : { no: r.leftNo, text: r.left }))
    .filter((l): l is { no: number; text: string } => l.no !== undefined && l.text !== null);
  if (lines.length === 0) return null;

  const first = lines[0]!.no;
  const last = lines[lines.length - 1]!.no;
  return {
    reference: formatReference({ path, line: first, endLine: last === first ? null : last, kind: 'file' }),
    text: lines.map((l) => l.text).join('\n'),
  };
}

/**
 * The first and last row of `rows` a range reaches, or nothing.
 *
 * Each row carries its own place in `rows` on itself. It used to be read off
 * the row's position in the tbody instead, which said the same thing right up
 * until the table started drawing a screenful at a time: the two spacer rows
 * that hold the scroll open are in the tbody and are not lines, and one of
 * them sits above everything, so every index would have been one out and a
 * copy would have named the wrong lines (bw-o5i3.3).
 *
 * Two ends and not a list, because only the drawn rows can be asked. A
 * selection dragged down a long diff scrolls as it goes, and the rows it
 * started in are unmounted by the time it stops — a list of what is drawn
 * would be a copy missing its own beginning. The ends are enough: what lies
 * between them is in `rows`, whether it is on the screen or not.
 */
function endsOfRange(table: HTMLTableElement, range: Range): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  for (const tr of table.tBodies[0]?.rows ?? []) {
    if (tr.dataset.rowAt === undefined || !range.intersectsNode(tr)) continue;
    const at = Number(tr.dataset.rowAt);
    if (at < from) from = at;
    if (at > to) to = at;
  }
  return to < from ? null : { from, to };
}

/**
 * The line a node is part of, or null when the node is not in a drawn row.
 *
 * Used on the selection's anchor — the row the reader pressed in — which is
 * the one end of a drag that does not move while the other one does.
 */
function rowOf(table: HTMLTableElement, node: Node | null): number | null {
  if (!node) return null;
  const from = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const row = from?.closest?.('tr[data-row-at]');
  if (!row || !table.contains(row)) return null;
  return Number((row as HTMLElement).dataset.rowAt);
}

/** The one range a reader has dragged inside this table, or nothing. */
function rangeInside(table: HTMLTableElement | null): Range | null {
  if (!table) return null;
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  return table.contains(range.commonAncestorContainer) ? range : null;
}

/** The widest a line number gutter has to be for the numbers it will hold. */
function gutterFor(rows: DiffRow[]): string {
  const highest = rows.reduce((most, r) => Math.max(most, r.leftNo ?? 0, r.rightNo ?? 0), 0);
  return `${Math.max(2, String(highest).length)}ch`;
}

/**
 * One line to a row below `md`, side by side above it (bw-e3dw.3).
 *
 * At 390px the table gave each side a 169px monospace column, and `break-all`
 * then cut every identifier in half to fill it — the diff was not overflowing,
 * it was shattered. So below the breakpoint the row becomes a two-track grid,
 * one gutter and one line of code, and the two sides are read one under the
 * other: a removed line over the added line that replaced it, each with its own
 * number on the one gutter. Above the breakpoint not a rule of this applies and
 * the table is exactly what it always was.
 */
const STACKED_ROW = 'max-md:grid max-md:grid-cols-[calc(var(--diff-gutter)_+_0.5rem)_minmax(0,1fr)]';

/**
 * A side there is no reason to draw in one column: one that is empty, and the
 * old side of an unchanged line, which would otherwise be printed twice.
 */
const OTHER_SIDE = 'max-md:hidden';

/**
 * How long a diff may be before it draws a screenful of itself at a time.
 *
 * Under this the table is exactly the table it always was, in whatever is
 * scrolling around it, because that is what nearly every diff is. Over it the
 * table becomes a box of its own with a window of rows in it.
 *
 * Where the line falls is a measurement, not a taste. Opened in a browser
 * against a checkout with nothing else changed, an un-windowed table cost one
 * long task of: nothing at 202 rows, 97 ms at 802, 245 ms at 2,002 and 433 ms
 * at 10,002, drawing 2,199, 7,599, 18,399 and 50,399 nodes. Eight hundred rows
 * is already the whole hundred milliseconds, so the line sits below it with
 * room to spare for a slower machine (bw-o5i3.3).
 *
 * Six hundred rows is around three hundred changed lines, so nearly every diff
 * anyone reads still draws whole, in the page that was already scrolling.
 */
const MANY_ROWS = 600;

/**
 * How long a diff may be before it is drawn without colouring.
 *
 * Both sides are coloured whole — a row coloured on its own reads the inside
 * of every block comment as fresh code — so the cost is the file's, not the
 * window's, and windowing the rows does not take it away. Measured: 32 ms a
 * side at 2,000 lines, 70 ms at 5,000, 149 ms at 10,000. Three thousand is
 * where two sides still fit inside a tenth of a second.
 *
 * A file this long already waits for a click before it opens at all.
 */
const TOO_LONG_TO_COLOUR = 3_000;

/**
 * A row's height before one has been measured, and the rows kept mounted
 * either side of the window.
 *
 * Only a starting guess: a line that wraps is taller than one that does not,
 * so every drawn row measures itself and the virtualiser corrects as it goes.
 */
const ROW_GUESS = 20;
const ROW_OVERSCAN = 20;

export function DiffTable({
  rows,
  language,
  path = null,
  className,
}: {
  rows: DiffRow[];
  language: string | null;
  /**
   * The path a copy names, repository-relative — the git diff knows one, the
   * edit card does not always, and a reference to a path nobody can resolve is
   * worse than the lines. Without it a copy is the browser's own copy.
   */
  path?: string | null;
  className?: string;
}) {
  // Each side is coloured whole and only then cut into its rows: painting a
  // row on its own left the inside of every block comment and every long
  // string read as fresh code (bw-4wcd.16).
  //
  // Held for the rows it was worked out from. It used to be worked out again
  // on every render, and the panel around this one re-reads itself every five
  // seconds (bw-o5i3.3).
  const painted = useMemo(() => {
    if (rows.length > TOO_LONG_TO_COLOUR) return rows.map(() => ({ left: null, right: null }));
    const leftLines = paintLines(rows.filter((r) => r.left !== null).map((r) => r.left!).join('\n'), language);
    const rightLines = paintLines(rows.filter((r) => r.right !== null).map((r) => r.right!).join('\n'), language);
    let li = 0;
    let ri = 0;
    return rows.map((r) => {
      const cell = {
        left: r.left === null || leftLines === null ? null : (leftLines[li] ?? null),
        right: r.right === null || rightLines === null ? null : (rightLines[ri] ?? null),
      };
      if (r.left !== null) li++;
      if (r.right !== null) ri++;
      return cell;
    });
  }, [rows, language]);
  const gutter = useMemo(() => gutterFor(rows), [rows]);

  const table = useRef<HTMLTableElement>(null);
  /** The box a long diff scrolls inside. Null while the diff is short. */
  const pane = useRef<HTMLDivElement>(null);
  const many = rows.length > MANY_ROWS;
  // Counted zero while the diff is short: the hook cannot be called
  // conditionally, and a virtualiser over nothing measures nothing.
  const virtual = useVirtualizer({
    count: many ? rows.length : 0,
    getScrollElement: () => pane.current,
    estimateSize: () => ROW_GUESS,
    overscan: ROW_OVERSCAN,
  });
  const window_ = virtual.getVirtualItems();
  /** Which rows are drawn: a window of them when there are many, else all. */
  const drawn = many ? window_.map((item) => item.index) : rows.map((_, at) => at);
  /** The scroll the window is not filling, held open above it and below it. */
  const above = many ? (window_[0]?.start ?? 0) : 0;
  const below = many ? virtual.getTotalSize() - (window_[window_.length - 1]?.end ?? 0) : 0;
  /** Where the floating button sits, and what it would copy, while there is one. */
  const [offer, setOffer] = useState<{ at: { left: number; top: number }; copied: CopiedDiff } | null>(null);

  /**
   * The line the selection being dragged right now was begun in.
   *
   * A drag down a long diff scrolls as it goes and unmounts the rows it began
   * in, so at any moment the drawn part of it may be missing its own start.
   * The start is the one end that does not move, so it is enough to have seen
   * it once — while it was still drawn — and to keep it for as long as it is
   * the same selection, which is what the anchor tells us. The other end is
   * read fresh every time, so a drag that overshoots and comes back names
   * where it came back to and not how far it went.
   */
  const began = useRef<{ anchor: Node | null; at: number | null; row: number } | null>(null);

  /** What the reader has selected inside this table right now, if anything. */
  const selected = useCallback((): { range: Range; copied: CopiedDiff } | null => {
    if (!path || !table.current) return null;
    const range = rangeInside(table.current);
    if (!range) {
      began.current = null;
      return null;
    }
    const ends = endsOfRange(table.current, range);
    if (!ends) return null;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    const at = selection?.anchorOffset ?? null;
    const before = began.current;
    const same = before !== null && before.anchor === anchor && before.at === at;
    const start = rowOf(table.current, anchor) ?? (same ? before.row : null);
    if (start !== null) began.current = { anchor, at, row: start };
    else began.current = null;
    // The start reaches out to wherever the other end is now, above it or
    // below it; when the start is drawn it is already one of these two ends
    // and this changes nothing.
    const from = start === null ? ends.from : Math.min(start, ends.from);
    const to = start === null ? ends.to : Math.max(start, ends.to);
    // Sliced out of `rows` and not out of the tbody: the lines between the two
    // ends are owed to the reader whether they are drawn at this moment or not.
    const copied = copiedFromRows(rows.slice(from, to + 1), path);
    return copied ? { range, copied } : null;
  }, [path, rows]);

  // The button follows the selection rather than the pointer, so it is in the
  // same place however the selection was made — a drag, a double-click, or a
  // keyboard. It goes as soon as the selection does.
  useEffect(() => {
    if (!path) return;
    const look = () => {
      const now = selected();
      if (!now) {
        setOffer(null);
        return;
      }
      // A range has no box where there is no layout, which is every test; the
      // button is still offered, it just has nowhere in particular to sit.
      const box = now.range.getBoundingClientRect?.() ?? { right: 0, bottom: 0 };
      setOffer({ at: { left: box.right, top: box.bottom + 6 }, copied: now.copied });
    };
    document.addEventListener('selectionchange', look);
    return () => document.removeEventListener('selectionchange', look);
  }, [path, selected]);

  return (
    <>
      {/* The box a long diff scrolls inside. Always here, so the table's own
          markup is one shape rather than two, and only a box when there is
          something to bound: a short diff scrolls with whatever is around it,
          which is what every diff used to do. */}
      <div
        ref={pane}
        data-testid="diff-pane"
        data-drawn={many ? 'window' : 'all'}
        className={cn(many && 'overflow-y-auto')}
        style={many ? { maxHeight: '70vh' } : undefined}
      >
        <table
          ref={table}
          data-testid="diff-table"
          // The copy a reader presses is answered with the reference, because
          // that is what they are about to paste into the chat; the lines
          // themselves are one click away and never further.
          onCopy={(event) => {
            const now = selected();
            if (!now) return;
            event.clipboardData.setData('text/plain', now.copied.reference);
            event.preventDefault();
          }}
          // The gutter is a `col` width above the breakpoint and a grid track
          // below it, and it is the same measurement either way, so it is worked
          // out once and read from here by both. The `0.5rem` the track adds is
          // the number cell's own `px-1`, which a `col` width already allows for.
          style={{ '--diff-gutter': gutter } as CSSProperties}
          className={cn(
            'w-full table-fixed border-collapse font-mono text-[11px] leading-relaxed text-foreground/80 max-md:block',
            className,
          )}
        >
          {/* Column widths belong to a table, and below the breakpoint this is
              not one. */}
          <colgroup className="max-md:hidden">
            <col style={{ width: gutter }} />
            <col />
            <col style={{ width: gutter }} />
            <col />
          </colgroup>
          <tbody className="max-md:block">
            {/* The scroll above the window, as one row of nothing. A table cannot
                hold its rows anywhere but in order, so the space a windowed
                table is not drawing is held by a row rather than by the
                absolute placing a list would use. */}
            {above > 0 && <tr aria-hidden="true" style={{ height: `${above}px` }} />}
            {drawn.map((i) => {
              const r = rows[i]!;
              return r.kind === 'gap' ? (
                <tr
                  key={i}
                  data-diff-kind="gap"
                  data-row-at={i}
                  data-index={i}
                  ref={many ? virtual.measureElement : undefined}
                  className={STACKED_ROW}
                >
                  <td colSpan={4} className="bg-muted/30 px-2 py-0.5 text-center text-t-faint select-none max-md:col-span-2">
                    {r.count} unchanged {r.count === 1 ? 'line' : 'lines'}
                  </td>
                </tr>
              ) : (
                <tr
                  key={i}
                  data-diff-kind={r.kind}
                  data-row-at={i}
                  data-index={i}
                  ref={many ? virtual.measureElement : undefined}
                  className={STACKED_ROW}
                >
                  <td
                    className={cn(
                      'px-1 py-0.5 text-right align-top tabular-nums text-t-faint select-none',
                      r.kind === 'removed' || r.kind === 'changed' ? 'bg-red-500/15' : '',
                      r.left === null && 'bg-muted/20',
                      (r.left === null || r.kind === 'same') && OTHER_SIDE,
                    )}
                  >
                    {r.leftNo ?? ''}
                  </td>
                  <td
                    className={cn(
                      // A word is broken only where it will not fit at all, and
                      // `break-all` — which cuts one wherever the line happens to
                      // end — is kept for the narrow columns that need it.
                      'whitespace-pre-wrap break-words md:break-all px-2 py-0.5 align-top',
                      r.kind === 'removed' || r.kind === 'changed' ? 'bg-red-500/15' : '',
                      r.left === null && 'bg-muted/20',
                      (r.left === null || r.kind === 'same') && OTHER_SIDE,
                    )}
                  >
                    {r.left === null ? '' : <Line text={r.left} language={language} html={painted[i]!.left} />}
                  </td>
                  <td
                    className={cn(
                      'border-l border-border/40 px-1 py-0.5 text-right align-top tabular-nums text-t-faint select-none',
                      // The rule divides two columns; below the breakpoint there
                      // are not two.
                      'max-md:border-l-0',
                      r.kind === 'added' || r.kind === 'changed' ? 'bg-emerald-500/15' : '',
                      r.right === null && 'bg-muted/20',
                      r.right === null && OTHER_SIDE,
                    )}
                  >
                    {r.rightNo ?? ''}
                  </td>
                  <td
                    className={cn(
                      'whitespace-pre-wrap break-words md:break-all px-2 py-0.5 align-top',
                      r.kind === 'added' || r.kind === 'changed' ? 'bg-emerald-500/15' : '',
                      r.right === null && 'bg-muted/20',
                      r.right === null && OTHER_SIDE,
                    )}
                  >
                    {r.right === null ? '' : <Line text={r.right} language={language} html={painted[i]!.right} />}
                  </td>
                </tr>
              );
            })}
            {below > 0 && <tr aria-hidden="true" style={{ height: `${below}px` }} />}
          </tbody>
        </table>
      </div>
      {offer && (
        <div
          data-testid="diff-copy-text"
          style={{ position: 'fixed', left: offer.at.left, top: offer.at.top, zIndex: 40 }}
          // Pressing the button must not be what takes the selection away, or
          // there would be nothing left to copy by the time the click lands.
          onMouseDown={(event) => event.preventDefault()}
          className="-translate-x-full"
        >
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="shadow-md"
            onClick={() => void navigator.clipboard?.writeText(offer.copied.text)}
          >
            <Copy /> Copy text
          </Button>
        </div>
      )}
    </>
  );
}
