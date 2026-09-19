/**
 * The change a large edit carries, worked out before the text is cut.
 *
 * The server does this for a live edit; this is the other producer, a chat
 * read back out of a provider's own record, where the full text is in hand on
 * this side of the wire (bw-vl3q.2).
 */
import { describe, expect, it } from 'vitest';

import { diffOf } from '@/workbench/imported-history';
import { changeOf } from '@/workbench/line-diff';

const big = (n: number) => Array.from({ length: n }, (_, at) => `line ${at + 1}`).join('\n') + '\n';

describe('what an edit changed', () => {
  it('reports the counts and only the changed lines of a large file', () => {
    const before = big(1500);
    const after = before.replace('line 1400\n', 'line 1400 changed\n');
    expect(before.length).toBeGreaterThan(10_000);

    const change = changeOf(before, after);
    expect(change.added).toBe(1);
    expect(change.removed).toBe(1);
    expect(change.beforeLines).toBe(1500);
    expect(change.hunks).toHaveLength(1);
    expect(change.hunks[0]!.oldStart).toBe(1394);
    // Six lines of context each side of the one changed line.
    expect(change.hunks[0]!.lines).toHaveLength(14);
    expect(JSON.stringify(change).length).toBeLessThan(1_000);
  });

  it('keeps changes far apart in hunks of their own', () => {
    const before = big(1200);
    const after = before.replace('line 100\n', 'one\n').replace('line 1100\n', 'two\n');

    const change = changeOf(before, after);
    expect(change.hunks.map((h) => h.oldStart)).toEqual([94, 1094]);
    expect(change.added).toBe(2);
  });

  it('numbers a fragment from where it sits in the file', () => {
    const change = changeOf('one\ntwo\n', 'one\nTWO\n', 400);
    expect(change.hunks[0]!.oldStart).toBe(400);
    expect(change.hunks[0]!.newStart).toBe(400);
  });

  it('cuts a whole new file inside its one hunk rather than carrying it all', () => {
    const change = changeOf('', big(3000));
    expect(change.added).toBe(3000);
    expect(change.hunks).toHaveLength(1);
    expect(change.hunks[0]!.lines).toHaveLength(400);
    expect(change.omittedLines).toBe(2600);
  });

  it('says nothing changed rather than drawing an empty change', () => {
    const change = changeOf('a\nb\n', 'a\nb\n');
    expect(change.added).toBe(0);
    expect(change.hunks).toHaveLength(0);
  });
});

describe('a diff read back out of a record', () => {
  it('carries the changed lines of a write past the text bound', () => {
    const content = big(1500);
    const diff = diffOf('Write', { file_path: '/a/big.tsx', content });

    expect(diff?.added).toBe(1500);
    expect(diff?.removed).toBe(0);
    expect(diff?.hunks?.length).toBe(1);
    // The text is still cut; the change is what survived it.
    expect(diff!.after.length).toBeLessThan(5_000);
  });

  it('numbers an edit from where the file it was found in puts it', () => {
    const source = big(200);
    const diff = diffOf('Edit', {
      file_path: '/a/big.tsx',
      old_string: 'line 150',
      new_string: 'line 150 changed',
    }, source);

    expect(diff?.line).toBe(150);
    expect(diff?.hunks?.[0]?.oldStart).toBe(150);
    expect(diff?.added).toBe(1);
    expect(diff?.removed).toBe(1);
  });
});
