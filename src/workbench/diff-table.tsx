/**
 * The one table that draws a diff, wherever the rows came from.
 *
 * The edit card works its rows out from the before and after text it was
 * handed; the git diff gets them from the hunks the server parsed. Neither
 * knows anything about the other, and both are drawn here, so a change to how
 * a removed line looks is one change (bw-rx1y.3).
 *
 * A table that knows which file it is showing copies the lines a selection
 * covered as they are written in the file, one side only, and answers a
 * right-click with a menu: copy, select all, and a reference to the lines —
 * `@diff:src/a.ts:+12-14` — to paste into the chat, where it becomes a badge
 * that opens this diff at those lines (bw-v79ny.2). It used to answer the copy
 * itself with the reference (bw-gr8y.8), which surprised anyone who wanted the
 * code; the reference is now one right-click away instead.
 *
 * On a phone the same rows are stacked into one column instead — see
 * `STACKED_ROW` — because two columns of code at 390px are two columns nobody
 * can read (bw-e3dw.3).
 *
 * Design: docs/agent-workbench.md §8.2.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronsDownUp, Copy, ExternalLink, Files, Quote, TextSelect } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { paintLines } from '@/workbench/colouring';
import { under } from '@/workbench/git-view';
import type { DiffRow } from '@/workbench/line-diff';
import { PointerAnchor } from '@/workbench/menu-anchor';
import { useOpenPath } from '@/workbench/open-path';
import { formatDiffReference, formatReference } from '@/workbench/references';
import { Line } from '@/workbench/split-paths';

/** What a selection out of a diff can put on the clipboard. */
export interface CopiedDiff {
  /** A reference to the file's lines, `@path:12-14` — the new side's numbers when there are any. */
  reference: string;
  /** A reference to the diff's lines, `@diff:path:+12-14`, naming the side they are counted on. */
  diff: string;
  /** Which side the lines were read from. */
  side: 'new' | 'old';
  /** The first and last line, on that side. */
  first: number;
  last: number;
  /** Those same lines as they are written in the file. */
  text: string;
}

/** A commit as a reference writes it: short, the way git shows one. */
function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null;
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
export function copiedFromRows(rows: DiffRow[], path: string, commit: string | null = null): CopiedDiff | null {
  const touched = rows.filter((r) => r.kind !== 'gap');
  const side = touched.some((r) => r.right !== null && r.rightNo) ? 'right' : 'left';
  const lines = touched
    .map((r) => (side === 'right' ? { no: r.rightNo, text: r.right } : { no: r.leftNo, text: r.left }))
    .filter((l): l is { no: number; text: string } => l.no !== undefined && l.text !== null);
  if (lines.length === 0) return null;

  const first = lines[0]!.no;
  const last = lines[lines.length - 1]!.no;
  const endLine = last === first ? null : last;
  const at = side === 'right' ? 'new' : 'old';
  return {
    reference: formatReference({ path, line: first, endLine, kind: 'file' }),
    diff: formatDiffReference({ commit: shortCommit(commit), path, side: at, line: first, endLine }),
    side: at,
    first,
    last,
    text: lines.map((l) => l.text).join('\n'),
  };
}

/**
 * The one line a right-click landed on, when nothing was selected: the side is
 * the column it landed in, so a changed row names its old line from the left
 * and its new line from the right. A gap, or an empty side, names no line.
 */
function lineUnder(table: HTMLTableElement, target: EventTarget | null, rows: DiffRow[]): { side: 'new' | 'old'; no: number } | null {
  const cell = (target as Element | null)?.closest?.('td');
  const tr = cell?.closest('tr[data-row-at]') as HTMLElement | null;
  if (!cell || !tr || !table.contains(tr)) return null;
  const row = rows[Number(tr.dataset.rowAt)];
  if (!row || row.kind === 'gap') return null;
  const left = (cell as HTMLTableCellElement).cellIndex < 2;
  if (left && row.leftNo) return { side: 'old', no: row.leftNo };
  if (!left && row.rightNo) return { side: 'new', no: row.rightNo };
  // The side it landed on is empty: the other side is the only line there is.
  if (row.rightNo) return { side: 'new', no: row.rightNo };
  if (row.leftNo) return { side: 'old', no: row.leftNo };
  return null;
}

/** Put something on the clipboard and say so, since nothing on screen moves. */
function copyOut(text: string, said: string): void {
  const done = navigator.clipboard?.writeText(text);
  if (done) void done.then(() => toast({ title: said }));
}

/** What a right-click in the table was about. */
interface MenuAsk {
  x: number;
  y: number;
  /** The selection it was made over, when there was one inside the table. */
  copied: CopiedDiff | null;
  /** The lines it names: the selection's, or the one line under the pointer. */
  side: 'new' | 'old';
  line: number | null;
  endLine: number | null;
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

/** Lines to mark and scroll to: a `@diff:` reference's, when one was opened. */
export interface MarkedLines {
  side?: 'new' | 'old';
  line?: number | null;
  endLine?: number | null;
  /** Tells one ask from the next, so asking again scrolls again. */
  asked: number;
}

/** Whether a row carries one of the marked lines. */
function isMarked(row: DiffRow, marked: MarkedLines | null | undefined): boolean {
  if (!marked?.line) return false;
  const no = marked.side === 'old' ? row.leftNo : row.rightNo;
  if (no === undefined || no === null) return false;
  return no >= marked.line && no <= (marked.endLine ?? marked.line);
}

export function DiffTable({
  rows,
  language,
  path = null,
  root = null,
  commit = null,
  marked = null,
  onCollapse,
  className,
}: {
  rows: DiffRow[];
  language: string | null;
  /**
   * The path a copy names, repository-relative — the git diff knows one, the
   * edit card does not always, and a reference to a path nobody can resolve is
   * worse than the lines. Without it a copy is the browser's own copy, and a
   * right-click is the browser's own menu.
   */
  path?: string | null;
  /** The checkout `path` is under, so the menu can open the file itself. */
  root?: string | null;
  /** The commit these rows are from, or null for uncommitted changes. */
  commit?: string | null;
  /** Shuts the file these rows belong to, when something around them can. */
  onCollapse?: () => void;
  /** Lines to mark and bring into view. */
  marked?: MarkedLines | null;
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
  // The marked lines are brought into view once they are drawn, after the
  // column around this table has scrolled to the file's heading: that scroll
  // runs in the parent's effect, which comes after this one, so this waits a
  // frame for it.
  const firstMarked = useMemo(() => rows.findIndex((row) => isMarked(row, marked)), [rows, marked]);
  useEffect(() => {
    if (firstMarked < 0) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (many) virtual.scrollToIndex(firstMarked, { align: 'center' });
        table.current
          ?.querySelector<HTMLElement>(`tr[data-row-at="${firstMarked}"]`)
          ?.scrollIntoView?.({ block: 'center' });
      });
    });
    return () => cancelAnimationFrame(frame);
    // Asked again is scrolled again; a re-read that changes nothing is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstMarked, marked?.asked]);
  const open = useOpenPath();
  /** The right-click being answered, while its menu is open. */
  const [asked, setAsked] = useState<MenuAsk | null>(null);

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
    const copied = copiedFromRows(rows.slice(from, to + 1), path, commit);
    return copied ? { range, copied } : null;
  }, [path, rows, commit]);

  /** A right-click on the table: the selection it was made over, or the line under it. */
  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLTableElement>) => {
      if (!path || !table.current) return;
      event.preventDefault();
      const now = selected();
      if (now) {
        const { copied } = now;
        setAsked({
          x: event.clientX,
          y: event.clientY,
          copied,
          side: copied.side,
          line: copied.first,
          endLine: copied.last === copied.first ? null : copied.last,
        });
        return;
      }
      const under_ = lineUnder(table.current, event.target, rows);
      setAsked({
        x: event.clientX,
        y: event.clientY,
        copied: null,
        side: under_?.side ?? 'new',
        line: under_?.no ?? null,
        endLine: null,
      });
    },
    [path, rows, selected],
  );

  /** Everything in the table, selected the way a drag over all of it would. */
  const selectAll = useCallback(() => {
    if (!table.current) return;
    const range = document.createRange();
    range.selectNodeContents(table.current);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

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
          // The copy a reader presses is the lines of one side, as they are
          // written in the file. The browser's own copy of a table would take
          // both sides of every row, one after the other.
          onCopy={(event) => {
            const now = selected();
            if (!now) return;
            event.clipboardData.setData('text/plain', now.copied.text);
            event.preventDefault();
          }}
          onContextMenu={onContextMenu}
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
                  data-marked={isMarked(r, marked) || undefined}
                  ref={many ? virtual.measureElement : undefined}
                  className={cn(STACKED_ROW, isMarked(r, marked) && 'outline outline-1 -outline-offset-1 outline-sky-500/70 [&>td]:!bg-sky-500/15')}
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
      {asked && path && (
        <DiffMenu
          asked={asked}
          path={path}
          root={root}
          commit={commit}
          onClose={() => setAsked(null)}
          onSelectAll={selectAll}
          onOpen={(line) => {
            if (root) open({ absolute: under(root, path), line, endLine: null }, 'files');
          }}
          onOpenInEditor={(line) => {
            if (root) open({ absolute: under(root, path), line, endLine: null }, 'editor');
          }}
          onCollapse={onCollapse}
        />
      )}
    </>
  );
}

/**
 * The menu behind a right-click in a diff: the common things to do with what
 * was selected, or with the line the pointer was on, and with the file.
 *
 * "Copy reference" is the diff's own form, `@diff:src/a.ts:+12-14`, which
 * pastes into the chat as a badge that opens this diff at these lines. "Copy
 * file reference" is the file's, `@src/a.ts:12-14`, and is only offered for
 * lines the file still has: a removed line is not in the file to point at.
 */
function DiffMenu({
  asked,
  path,
  root,
  commit,
  onClose,
  onSelectAll,
  onOpen,
  onOpenInEditor,
  onCollapse,
}: {
  asked: MenuAsk;
  path: string;
  root: string | null;
  commit: string | null;
  onClose: () => void;
  onSelectAll: () => void;
  onOpen: (line: number | null) => void;
  onOpenInEditor: (line: number | null) => void;
  onCollapse?: () => void;
}) {
  const diff = formatDiffReference({
    commit: shortCommit(commit),
    path,
    side: asked.side,
    line: asked.line,
    endLine: asked.endLine,
  });
  /** The line in the file as it is now, when the lines are on the new side. */
  const newLine = asked.side === 'new' ? asked.line : null;
  const file = formatReference({ path, line: newLine, endLine: newLine === null ? null : asked.endLine, kind: 'file' });
  return (
    <DropdownMenu open modal={false} onOpenChange={(now) => { if (!now) onClose(); }}>
      <PointerAnchor at={{ left: asked.x, top: asked.y }} />
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={0}
        className="w-56"
        data-testid="diff-menu"
        // The keyboard and the selection stay where they were.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuItem
          data-testid="diff-menu-copy"
          disabled={!asked.copied}
          onSelect={() => asked.copied && copyOut(asked.copied.text, 'Copied')}
        >
          <Copy aria-hidden="true" /> Copy
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="diff-menu-select-all" onSelect={onSelectAll}>
          <TextSelect aria-hidden="true" /> Select all
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="diff-menu-copy-reference" onSelect={() => copyOut(diff, 'Reference copied')}>
          <Quote aria-hidden="true" /> Copy reference
        </DropdownMenuItem>
        {(asked.line === null || newLine !== null) && (
          <DropdownMenuItem
            data-testid="diff-menu-copy-file-reference"
            onSelect={() => copyOut(file, 'File reference copied')}
          >
            <Quote aria-hidden="true" /> Copy file reference
          </DropdownMenuItem>
        )}
        {root && (
          <DropdownMenuItem data-testid="diff-menu-copy-path" onSelect={() => copyOut(under(root, path), 'Path copied')}>
            <Copy aria-hidden="true" /> Copy path
          </DropdownMenuItem>
        )}
        <DropdownMenuItem data-testid="diff-menu-copy-relative-path" onSelect={() => copyOut(path, 'Relative path copied')}>
          <Copy aria-hidden="true" /> Copy relative path
        </DropdownMenuItem>
        {root && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="diff-menu-open" onSelect={() => onOpen(newLine)}>
              <Files aria-hidden="true" /> Open in Files
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="diff-menu-editor" onSelect={() => onOpenInEditor(newLine)}>
              <ExternalLink aria-hidden="true" /> Open in editor
            </DropdownMenuItem>
          </>
        )}
        {onCollapse && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="diff-menu-collapse" onSelect={onCollapse}>
              <ChevronsDownUp aria-hidden="true" /> Collapse file
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
