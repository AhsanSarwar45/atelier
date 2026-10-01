import { describe, expect, it } from 'vitest';

import cases from '@/workbench/atelier-references.cases.json';
import { findAtelierReferences, findReferences, formatAtelierReference, formatDiffReference, parseDiffId } from '@/workbench/references';

describe('a reference to a card, a chat or a skill', () => {
  for (const c of cases) {
    it(`reads ${JSON.stringify(c.text)}`, () => {
      expect(findAtelierReferences(c.text)).toEqual(c.found);
    });
  }

  it('is never read as a file as well', () => {
    expect(findReferences('see @bead:bw-1 and @src/a.ts')).toEqual([
      expect.objectContaining({ path: 'src/a.ts' }),
    ]);
  });

  it('is written in the one form it is read in', () => {
    const written = formatAtelierReference('chat', 'abc-1');
    expect(findAtelierReferences(written)).toEqual([{ kind: 'chat', id: 'abc-1', start: 0, end: written.length, run: false }]);
  });
});

describe('a reference to a diff', () => {
  it('names its commit, its file and its lines', () => {
    expect(parseDiffId('src/a.ts:+12-14')).toEqual({ commit: null, path: 'src/a.ts', side: 'new', line: 12, endLine: 14 });
    expect(parseDiffId('abc1234:src/a.ts:-30')).toEqual({ commit: 'abc1234', path: 'src/a.ts', side: 'old', line: 30, endLine: null });
    // A file whose name looks like a commit is still a file.
    expect(parseDiffId('abcdef1:+3')?.path).toBe('abcdef1');
    expect(parseDiffId('README.md')).toEqual({ commit: null, path: 'README.md', side: 'new', line: null, endLine: null });
  });

  it('is written in the one form it is read in', () => {
    for (const id of ['src/a.ts:+12-14', 'abc1234:src/a.ts:-30', 'README.md']) {
      const written = formatDiffReference(parseDiffId(id)!);
      expect(written).toBe(`@diff:${id}`);
      expect(findAtelierReferences(`see ${written}.`)).toEqual([{ kind: 'diff', id, start: 4, end: 4 + written.length, run: false }]);
    }
  });

  it('is never read as a file as well', () => {
    expect(findReferences('see @diff:src/a.ts:+3 and @src/b.ts')).toEqual([expect.objectContaining({ path: 'src/b.ts' })]);
  });
});
