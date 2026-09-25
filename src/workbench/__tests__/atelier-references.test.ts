import { describe, expect, it } from 'vitest';

import cases from '@/workbench/atelier-references.cases.json';
import { findAtelierReferences, findReferences, formatAtelierReference } from '@/workbench/references';

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
