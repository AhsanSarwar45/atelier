/**
 * Line diff for the side-by-side change view.
 *
 * Longest-common-subsequence, so a line that merely moved is not reported as a
 * change: what is marked is what actually differs. Inputs here are the
 * fragments a tool was given, not whole files, so they stay small.
 */

export interface DiffRow {
  left: string | null;
  right: string | null;
  kind: 'same' | 'removed' | 'added' | 'changed';
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

export function diffLines(before: string, after: string): DiffRow[] {
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

  // A removal immediately followed by an addition is one line rewritten;
  // pairing them puts the old and new text on the same row, side by side.
  const paired: DiffRow[] = [];
  for (let k = 0; k < rows.length; k++) {
    const cur = rows[k]!;
    const next = rows[k + 1];
    if (cur.kind === 'removed' && next?.kind === 'added') {
      paired.push({ left: cur.left, right: next.right, kind: 'changed' });
      k++;
    } else {
      paired.push(cur);
    }
  }
  return paired;
}
