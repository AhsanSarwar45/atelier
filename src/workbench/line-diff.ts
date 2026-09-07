/**
 * Line diff for the side-by-side change view.
 *
 * Longest-common-subsequence, so a line that merely moved is not reported as a
 * change: what is marked is what actually differs. Inputs here are the
 * fragments a tool was given, not whole files, so they stay small.
 *
 * The same rows also come from the other direction: the server hands the git
 * diff over already cut into hunks, and `hunksToRows` turns those into the very
 * same shape, so the edit card and the git diff are drawn by one table
 * (bw-rx1y.3).
 */

export interface DiffRow {
  left: string | null;
  right: string | null;
  kind: 'same' | 'removed' | 'added' | 'changed' | 'gap';
  /** Where `left` sits in the old text, counting from one, when it is known. */
  leftNo?: number;
  /** Where `right` sits in the new text, counting from one, when it is known. */
  rightNo?: number;
  /** How many unchanged lines a `gap` row stands in for. */
  count?: number;
}

/** One line of a unified hunk, as the server's /api/git/diff writes it. */
export interface DiffHunkLine {
  kind: 'context' | 'removed' | 'added';
  text: string;
}

/**
 * One unified hunk. The shape is repeated here rather than imported from the
 * api module so that this file stays a plain function over plain data, and can
 * be read and tested without the browser's client.
 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffHunkLine[];
}

function lcs(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

/**
 * A removal immediately followed by an addition is one line rewritten; pairing
 * them puts the old and the new text on the same row, side by side. Both ends
 * of the app want this rule, so both call it here.
 */
function pairChanges(rows: DiffRow[]): DiffRow[] {
  const paired: DiffRow[] = [];
  for (let k = 0; k < rows.length; k++) {
    const cur = rows[k]!;
    const next = rows[k + 1];
    if (cur.kind === 'removed' && next?.kind === 'added') {
      paired.push({ ...cur, right: next.right, rightNo: next.rightNo, kind: 'changed' });
      k++;
    } else {
      paired.push(cur);
    }
  }
  return paired;
}

/**
 * Two texts as rows. `startLine` is where both texts begin in the file they
 * were cut from, so an edit card can number its gutter from the right place;
 * left unsaid the numbering starts at one.
 */
export function diffLines(before: string, after: string, startLine = 1): DiffRow[] {
  const a = before.length ? before.replace(/\n$/, '').split('\n') : [];
  const b = after.length ? after.replace(/\n$/, '').split('\n') : [];
  const table = lcs(a, b);

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ left: a[i]!, right: b[j]!, kind: 'same' });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      rows.push({ left: a[i]!, right: null, kind: 'removed' });
      i++;
    } else {
      rows.push({ left: null, right: b[j]!, kind: 'added' });
      j++;
    }
  }
  while (i < a.length) rows.push({ left: a[i++]!, right: null, kind: 'removed' });
  while (j < b.length) rows.push({ left: null, right: b[j++]!, kind: 'added' });

  let leftNo = startLine;
  let rightNo = startLine;
  for (const row of rows) {
    if (row.left !== null) row.leftNo = leftNo++;
    if (row.right !== null) row.rightNo = rightNo++;
  }
  return pairChanges(rows);
}

/**
 * Unified hunks as rows, numbered on both sides.
 *
 * Between two hunks stands one `gap` row saying how many lines were left out;
 * there is none before the first hunk or after the last, because a file that
 * begins or ends unchanged is not a hole in the middle of what is drawn.
 */
export function hunksToRows(hunks: DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  hunks.forEach((hunk, at) => {
    const before = hunks[at - 1];
    if (before) {
      const count = hunk.oldStart - (before.oldStart + before.oldLines);
      if (count > 0) rows.push({ left: null, right: null, kind: 'gap', count });
    }
    let leftNo = hunk.oldStart;
    let rightNo = hunk.newStart;
    const within: DiffRow[] = [];
    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        within.push({ left: line.text, right: line.text, kind: 'same', leftNo: leftNo++, rightNo: rightNo++ });
      } else if (line.kind === 'removed') {
        within.push({ left: line.text, right: null, kind: 'removed', leftNo: leftNo++ });
      } else {
        within.push({ left: null, right: line.text, kind: 'added', rightNo: rightNo++ });
      }
    }
    // Pairing is done inside each hunk: a removal at the end of one hunk and an
    // addition at the start of the next are hundreds of lines apart in the
    // file and are not one line rewritten.
    rows.push(...pairChanges(within));
  });
  return rows;
}
