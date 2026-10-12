/**
 * The strip above the writing box and the badges inside it are one list.
 */
import { describe, it, expect } from 'vitest';

import { imageMarker, type DraftPicture } from '@/workbench/composer-attachments';
import { baseName, draftFiles, withoutFile } from '@/workbench/draft-files';

const WHERE = { cwd: '/home/me/project', home: '/home/me' };
const REAL = () => true;

function attached(id: string, alt: string): DraftPicture {
  return { id, alt, mime: 'image/png', dataUrl: 'data:image/png;base64,AA' };
}

describe('every file a draft names', () => {
  it('finds an attached file by its marker', () => {
    const one = attached('a', 'shot.png');
    const draft = `look at ${imageMarker('a')} please`;
    const found = draftFiles(draft, [one], WHERE, REAL);
    expect(found.map((f) => f.file.alt)).toEqual(['shot.png']);
    expect(found[0]!.picture).toBe(one);
    expect(draft.slice(found[0]!.from, found[0]!.to)).toBe(imageMarker('a'));
  });

  // The whole of bw-oamr.8: a path had a badge in the box and no tile above it.
  it('finds a path the reader typed, and points at it on disk', () => {
    const found = draftFiles('compare @src/a.ts:4-9 with it', [], WHERE, REAL);
    expect(found.map((f) => f.file.alt)).toEqual(['a.ts']);
    expect(found[0]!.file.path).toBe('/home/me/project/src/a.ts');
    expect(found[0]!.file.dataUrl).toBe('');
    expect(found[0]!.picture).toBeUndefined();
  });

  it('reads them in the order they were written', () => {
    const draft = `@src/a.ts then ${imageMarker('b')} then @docs/b.md`;
    expect(draftFiles(draft, [attached('b', 'shot.png')], WHERE, REAL).map((f) => f.file.alt)).toEqual([
      'a.ts',
      'shot.png',
      'b.md',
    ]);
  });

  it('leaves out a folder, and a name with nowhere to hang it', () => {
    expect(draftFiles('@src/ is a folder', [], WHERE, REAL)).toEqual([]);
    expect(draftFiles('@src/a.ts', [], { cwd: '', home: '' }, REAL)).toEqual([]);
  });

  // `@skill` left behind by Backspace is words, not a file called `skill`.
  it('leaves out a name that is not on disk', () => {
    const real = (path: string) => path === '/home/me/project/src/a.ts';
    expect(draftFiles('@src/a.ts and @skill', [], WHERE, real).map((f) => f.file.alt)).toEqual(['a.ts']);
  });

  it('leaves out an attached file whose marker is no longer in the draft', () => {
    expect(draftFiles('nothing here', [attached('a', 'shot.png')], WHERE, REAL)).toEqual([]);
  });
});

describe('taking one out of the words', () => {
  it('takes the characters and one adjoining space', () => {
    const draft = 'compare @src/a.ts with it';
    const [one] = draftFiles(draft, [], WHERE, REAL);
    expect(withoutFile(draft, one!)).toBe('compare with it');
  });

  it('takes the space in front when there is none behind', () => {
    const draft = 'look at @src/a.ts';
    const [one] = draftFiles(draft, [], WHERE, REAL);
    expect(withoutFile(draft, one!)).toBe('look at');
  });

  it('takes an attached file out by its marker', () => {
    const draft = `here ${imageMarker('a')} it is`;
    const [one] = draftFiles(draft, [attached('a', 'shot.png')], WHERE, REAL);
    expect(withoutFile(draft, one!)).toBe('here it is');
  });
});

describe('the name a person calls a file', () => {
  it('is the last part of the address', () => {
    expect(baseName('/a/b/c.txt')).toBe('c.txt');
    expect(baseName('c.txt')).toBe('c.txt');
    expect(baseName('/a/b/')).toBe('b');
  });
});
