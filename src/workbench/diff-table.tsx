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
 * Design: docs/agent-workbench.md §8.2.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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

/** The rows a range reaches into, in the order they are drawn. */
function rowsInRange(table: HTMLTableElement, range: Range, rows: DiffRow[]): DiffRow[] {
  const drawn = [...(table.tBodies[0]?.rows ?? [])];
  return drawn.map((tr, at) => (range.intersectsNode(tr) ? rows[at] : undefined)).filter((r): r is DiffRow => !!r);
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
  const leftLines = paintLines(rows.filter((r) => r.left !== null).map((r) => r.left!).join('\n'), language);
  const rightLines = paintLines(rows.filter((r) => r.right !== null).map((r) => r.right!).join('\n'), language);
  let li = 0;
  let ri = 0;
  const painted = rows.map((r) => {
    const cell = {
      left: r.left === null || leftLines === null ? null : (leftLines[li] ?? null),
      right: r.right === null || rightLines === null ? null : (rightLines[ri] ?? null),
    };
    if (r.left !== null) li++;
    if (r.right !== null) ri++;
    return cell;
  });
  const gutter = gutterFor(rows);

  const table = useRef<HTMLTableElement>(null);
  /** Where the floating button sits, and what it would copy, while there is one. */
  const [offer, setOffer] = useState<{ at: { left: number; top: number }; copied: CopiedDiff } | null>(null);

  /** What the reader has selected inside this table right now, if anything. */
  const selected = useCallback((): { range: Range; copied: CopiedDiff } | null => {
    if (!path || !table.current) return null;
    const range = rangeInside(table.current);
    if (!range) return null;
    const copied = copiedFromRows(rowsInRange(table.current, range, rows), path);
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
        className={cn('w-full table-fixed border-collapse font-mono text-[11px] leading-relaxed text-foreground/80', className)}
      >
        <colgroup>
          <col style={{ width: gutter }} />
          <col />
          <col style={{ width: gutter }} />
          <col />
        </colgroup>
        <tbody>
          {rows.map((r, i) =>
            r.kind === 'gap' ? (
              <tr key={i} data-diff-kind="gap">
                <td colSpan={4} className="bg-muted/30 px-2 py-0.5 text-center text-t-faint select-none">
                  {r.count} unchanged {r.count === 1 ? 'line' : 'lines'}
                </td>
              </tr>
            ) : (
              <tr key={i} data-diff-kind={r.kind}>
                <td
                  className={cn(
                    'px-1 py-0.5 text-right align-top tabular-nums text-t-faint select-none',
                    r.kind === 'removed' || r.kind === 'changed' ? 'bg-red-500/15' : '',
                    r.left === null && 'bg-muted/20',
                  )}
                >
                  {r.leftNo ?? ''}
                </td>
                <td
                  className={cn(
                    'whitespace-pre-wrap break-all px-2 py-0.5 align-top',
                    r.kind === 'removed' || r.kind === 'changed' ? 'bg-red-500/15' : '',
                    r.left === null && 'bg-muted/20',
                  )}
                >
                  {r.left === null ? '' : <Line text={r.left} language={language} html={painted[i]!.left} />}
                </td>
                <td
                  className={cn(
                    'border-l border-border/40 px-1 py-0.5 text-right align-top tabular-nums text-t-faint select-none',
                    r.kind === 'added' || r.kind === 'changed' ? 'bg-emerald-500/15' : '',
                    r.right === null && 'bg-muted/20',
                  )}
                >
                  {r.rightNo ?? ''}
                </td>
                <td
                  className={cn(
                    'whitespace-pre-wrap break-all px-2 py-0.5 align-top',
                    r.kind === 'added' || r.kind === 'changed' ? 'bg-emerald-500/15' : '',
                    r.right === null && 'bg-muted/20',
                  )}
                >
                  {r.right === null ? '' : <Line text={r.right} language={language} html={painted[i]!.right} />}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
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
