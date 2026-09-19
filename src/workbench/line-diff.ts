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

/**
 * What an edit changed: the counts, and the changed lines with context.
 *
 * The server works this out for a live edit before the wire limit cuts the
 * text (see `server/src/workbench/hunks.rs`); this is the same answer for the
 * other producer, a chat read back out of a provider's own record, where the
 * full text is in hand on this side of the wire instead (bw-vl3q.2).
 */
export interface EditChange {
  /** Lines the file gained. Exact, whatever had to be left undrawn. */
  added: number;
  /** Lines it lost. Exact in the same way. */
  removed: number;
  beforeLines: number;
  afterLines: number;
  /** The changed lines with context, in file order. */
  hunks: DiffHunk[];
  /** Hunks left out of `hunks` entirely, when there were too many to draw. */
  omittedHunks?: number;
  /** Lines clipped off the last hunk drawn, when it ran past the bound. */
  omittedLines?: number;
}

/** Unchanged lines kept either side of a changed run. Matches the server's. */
const CONTEXT = 6;
/** The most hunks one edit carries, and the most lines between them. */
const MAX_HUNKS = 30;
const MAX_LINES = 400;

/** A body as lines, without the one newline that ends a file. */
function toLines(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
}

/**
 * The same change the server reports, worked out here.
 *
 * The rows are taken from `diffLines` over the changed middle alone — the
 * shared head and tail of a whole-file write are never compared — and then cut
 * into hunks by the server's rules, so both producers hand the card one shape.
 */
export function changeOf(before: string, after: string, startLine = 1): EditChange {
  const a = toLines(before);
  const b = toLines(after);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  const most = Math.min(a.length, b.length) - prefix;
  while (suffix < most && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const ops: DiffRow[] = [];
  const head = Math.max(0, prefix - CONTEXT);
  for (let at = head; at < prefix; at++) {
    const no = at + startLine;
    ops.push({ left: a[at]!, right: a[at]!, kind: 'same', leftNo: no, rightNo: no });
  }
  // A row that pairs a removal with the addition replacing it is one line of
  // each for a hunk, which counts its sides separately.
  for (const row of diffLines(
    a.slice(prefix, a.length - suffix).join('\n'),
    b.slice(prefix, b.length - suffix).join('\n'),
    prefix + startLine,
  )) {
    if (row.kind === 'changed') {
      ops.push({ left: row.left, right: null, kind: 'removed', leftNo: row.leftNo });
      ops.push({ left: null, right: row.right, kind: 'added', rightNo: row.rightNo });
    } else {
      ops.push(row);
    }
  }
  for (let at = 0; at < Math.min(suffix, CONTEXT); at++) {
    const text = a[a.length - suffix + at]!;
    ops.push({
      left: text,
      right: text,
      kind: 'same',
      leftNo: a.length - suffix + at + startLine,
      rightNo: b.length - suffix + at + startLine,
    });
  }

  const added = ops.filter((o) => o.kind === 'added').length;
  const removed = ops.filter((o) => o.kind === 'removed').length;

  // Every changed line claims CONTEXT lines either side; spans that then touch
  // are one hunk, because two hunks with no gap between them are one hunk.
  const spans: [number, number][] = [];
  ops.forEach((op, at) => {
    if (op.kind === 'same') return;
    const from = Math.max(0, at - CONTEXT);
    const to = Math.min(ops.length, at + CONTEXT + 1);
    const last = spans[spans.length - 1];
    if (last && from <= last[1]) last[1] = to;
    else spans.push([from, to]);
  });

  const hunks: DiffHunk[] = [];
  let budget = MAX_LINES;
  let omittedHunks = 0;
  let omittedLines = 0;
  for (const [from, to] of spans) {
    const size = to - from;
    if (hunks.length >= MAX_HUNKS || budget === 0) {
      omittedHunks++;
      omittedLines += size;
    } else if (size <= budget) {
      budget -= size;
      hunks.push(toHunk(ops.slice(from, to)));
    } else {
      hunks.push(toHunk(ops.slice(from, from + budget)));
      omittedLines += size - budget;
      budget = 0;
    }
  }

  return {
    added,
    removed,
    beforeLines: a.length,
    afterLines: b.length,
    hunks,
    ...(omittedHunks ? { omittedHunks } : {}),
    ...(omittedLines ? { omittedLines } : {}),
  };
}

/** One run of rows written as a hunk. */
function toHunk(ops: DiffRow[]): DiffHunk {
  const oldLines = ops.filter((o) => o.kind !== 'added').length;
  const newLines = ops.filter((o) => o.kind !== 'removed').length;
  const first = ops[0]!;
  return {
    // A hunk with nothing on one side starts at the line before it, which is
    // nothing; git writes that as zero and so does the server.
    oldStart: oldLines === 0 ? 0 : (first.leftNo ?? first.rightNo ?? 1),
    oldLines,
    newStart: newLines === 0 ? 0 : (first.rightNo ?? first.leftNo ?? 1),
    newLines,
    lines: ops.map((o) => ({
      kind: o.kind === 'added' ? 'added' : o.kind === 'removed' ? 'removed' : 'context',
      text: (o.kind === 'added' ? o.right : o.left) ?? '',
    })),
  };
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
