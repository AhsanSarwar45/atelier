/**
 * The git diff's hunks become the rows the edit card's table already draws.
 *
 * The server does the diffing, so the browser never re-runs the O(n*m) LCS over
 * a whole file; what arrives is hunks, and what the table wants is rows. This
 * is that translation: numbered on both sides, a rewritten line paired the same
 * way the edit card pairs it, and one gap row for the lines left out between
 * two hunks (bw-rx1y.3).
 */
import { describe, expect, it } from 'vitest';

import { diffLines, hunksToRows, type DiffHunk } from '@/workbench/line-diff';

/** A hunk written the short way, so the cases below read as diffs. */
function hunk(oldStart: number, newStart: number, lines: string[]): DiffHunk {
  const parsed = lines.map((line) => ({
    kind: line[0] === '-' ? ('removed' as const) : line[0] === '+' ? ('added' as const) : ('context' as const),
    text: line.slice(1),
  }));
  return {
    oldStart,
    oldLines: parsed.filter((l) => l.kind !== 'added').length,
    newStart,
    newLines: parsed.filter((l) => l.kind !== 'removed').length,
    lines: parsed,
  };
}

describe('unified hunks as diff rows', () => {
  it('numbers both sides through a hunk of mixed lines', () => {
    const rows = hunksToRows([hunk(10, 10, [' a', '-b', '-c', '+B', ' d'])]);
    // Two lines went out and one came back, so the second removal is the one
    // paired with it, exactly as the edit card pairs a run of changes.
    expect(rows).toEqual([
      { left: 'a', right: 'a', kind: 'same', leftNo: 10, rightNo: 10 },
      { left: 'b', right: null, kind: 'removed', leftNo: 11 },
      { left: 'c', right: 'B', kind: 'changed', leftNo: 12, rightNo: 11 },
      { left: 'd', right: 'd', kind: 'same', leftNo: 13, rightNo: 12 },
    ]);
  });

  it('pairs a removal followed by an addition, exactly as the edit card does', () => {
    const [row] = hunksToRows([hunk(1, 1, ['-one', '+two'])]);
    expect(row).toMatchObject({ left: 'one', right: 'two', kind: 'changed' });
    expect(diffLines('one', 'two')[0]).toMatchObject({ kind: 'changed' });
  });

  it('stands one gap row between two hunks and none at either end', () => {
    const rows = hunksToRows([hunk(1, 1, ['-a', '+A']), hunk(20, 20, ['-z', '+Z'])]);
    expect(rows.map((r) => r.kind)).toEqual(['changed', 'gap', 'changed']);
    // Hunk one covered old line 1; hunk two starts at old line 20, so 18 lines
    // of the file were never sent.
    expect(rows[1]).toEqual({ left: null, right: null, kind: 'gap', count: 18 });
  });

  it('says nothing between hunks that touch', () => {
    const rows = hunksToRows([hunk(1, 1, ['-a', '+A']), hunk(2, 2, ['-b', '+B'])]);
    expect(rows.map((r) => r.kind)).toEqual(['changed', 'changed']);
  });

  it('reads a pure addition as rows with a right side only', () => {
    const rows = hunksToRows([hunk(0, 1, ['+one', '+two'])]);
    expect(rows).toEqual([
      { left: null, right: 'one', kind: 'added', rightNo: 1 },
      { left: null, right: 'two', kind: 'added', rightNo: 2 },
    ]);
  });

  it('reads a pure deletion as rows with a left side only', () => {
    const rows = hunksToRows([hunk(1, 0, ['-one', '-two'])]);
    expect(rows).toEqual([
      { left: 'one', right: null, kind: 'removed', leftNo: 1 },
      { left: 'two', right: null, kind: 'removed', leftNo: 2 },
    ]);
  });

  it('has nothing to draw for a file whose content did not move', () => {
    expect(hunksToRows([])).toEqual([]);
  });
});

describe('the edit card numbers its own rows', () => {
  it('counts from one when nobody says where the fragment began', () => {
    expect(diffLines('a\nb', 'a\nc')).toEqual([
      { left: 'a', right: 'a', kind: 'same', leftNo: 1, rightNo: 1 },
      { left: 'b', right: 'c', kind: 'changed', leftNo: 2, rightNo: 2 },
    ]);
  });

  it('counts from where the fragment sits in the file when it is told', () => {
    const rows = diffLines('a\nb', 'a\nb\nc', 40);
    expect(rows.map((r) => [r.leftNo, r.rightNo])).toEqual([
      [40, 40],
      [41, 41],
      [undefined, 42],
    ]);
  });
});
