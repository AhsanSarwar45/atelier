/**
 * The one table that draws a diff, wherever the rows came from.
 *
 * The edit card works its rows out from the before and after text it was
 * handed; the git diff gets them from the hunks the server parsed. Neither
 * knows anything about the other, and both are drawn here, so a change to how
 * a removed line looks is one change (bw-rx1y.3).
 *
 * Design: docs/agent-workbench.md §8.2.
 */
'use client';

import { cn } from '@/lib/utils';
import { paintLines } from '@/workbench/colouring';
import type { DiffRow } from '@/workbench/line-diff';
import { Line } from '@/workbench/split-paths';

/** The widest a line number gutter has to be for the numbers it will hold. */
function gutterFor(rows: DiffRow[]): string {
  const highest = rows.reduce((most, r) => Math.max(most, r.leftNo ?? 0, r.rightNo ?? 0), 0);
  return `${Math.max(2, String(highest).length)}ch`;
}

export function DiffTable({ rows, language, className }: { rows: DiffRow[]; language: string | null; className?: string }) {
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
  return (
    <table
      data-testid="diff-table"
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
  );
}
