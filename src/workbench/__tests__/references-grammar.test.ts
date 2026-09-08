/**
 * The grammar of a file reference: what one token is read as, and what one is
 * written back out as.
 *
 * Every form the app has to read is here, our own and the two Claude Code's IDE
 * plugins write, alongside the things that merely look like references and are
 * not (bw-gr8y.2).
 */
import { describe, expect, it } from 'vitest';

import {
  formatReference,
  parseReference,
  referenceLabel,
  resolveReference,
  type Reference,
} from '@/workbench/references';

const file = (
  path: string,
  line: number | null = null,
  endLine: number | null = null,
): Reference => ({
  path,
  line,
  endLine,
  kind: 'file',
});

describe('reading one reference', () => {
  it('reads a path on its own', () => {
    expect(parseReference('@src/a.ts')).toEqual(file('src/a.ts'));
  });

  it('reads a line', () => {
    expect(parseReference('@src/a.ts:12')).toEqual(file('src/a.ts', 12));
  });

  it('reads a range of lines', () => {
    expect(parseReference('@src/a.ts:12-40')).toEqual(file('src/a.ts', 12, 40));
  });

  it('reads a trailing slash as a folder, which has no lines', () => {
    expect(parseReference('@src/')).toEqual({
      path: 'src',
      line: null,
      endLine: null,
      kind: 'folder',
    });
    expect(parseReference('@src/workbench/')).toEqual({
      path: 'src/workbench',
      line: null,
      endLine: null,
      kind: 'folder',
    });
  });

  it("reads the forms Claude Code's IDE plugins write", () => {
    expect(parseReference('@src/a.ts#L12-L40')).toEqual(file('src/a.ts', 12, 40));
    expect(parseReference('@src/a.ts#L12')).toEqual(file('src/a.ts', 12));
    expect(parseReference('@src/a.ts#12-40')).toEqual(file('src/a.ts', 12, 40));
    expect(parseReference('@src/a.ts#12')).toEqual(file('src/a.ts', 12));
  });

  it('reads a quoted path, which is the only one that may hold a space', () => {
    expect(parseReference('@"a path/with spaces.ts:3"')).toEqual(file('a path/with spaces.ts', 3));
    expect(parseReference('@"a path/with spaces.ts"')).toEqual(file('a path/with spaces.ts'));
  });

  it('leaves the column nobody opens on out of it', () => {
    expect(parseReference('@src/a.ts:12:7')).toEqual(file('src/a.ts', 12));
  });

  it('is a single line when both ends of the range are the same', () => {
    expect(parseReference('@src/a.ts:9-9')).toEqual(file('src/a.ts', 9));
  });

  it('reads a path that is already absolute, or written from home', () => {
    expect(parseReference('@/home/me/a.ts:4')).toEqual(file('/home/me/a.ts', 4));
    expect(parseReference('@~/notes.md')).toEqual(file('~/notes.md'));
  });

  it('does not eat the punctuation the sentence around it owns', () => {
    expect(parseReference('@src/a.ts.')).toEqual(file('src/a.ts'));
    expect(parseReference('@src/a.ts,')).toEqual(file('src/a.ts'));
    expect(parseReference('@src/a.ts)')).toEqual(file('src/a.ts'));
    expect(parseReference('@src/a.ts;')).toEqual(file('src/a.ts'));
  });

  it('tells a trailing colon from a line', () => {
    expect(parseReference('@src/a.ts:')).toEqual(file('src/a.ts'));
    expect(parseReference('@src/a.ts:12')).toEqual(file('src/a.ts', 12));
  });

  it('is nothing at all when there is no path', () => {
    expect(parseReference('@')).toBeNull();
    expect(parseReference('@ ')).toBeNull();
    expect(parseReference('@,')).toBeNull();
  });

  it('is nothing when the @ sits inside a word, which is what an email is', () => {
    expect(parseReference('user@host')).toBeNull();
    expect(parseReference('someone@example.com')).toBeNull();
  });

  it('is nothing when an unquoted path is broken by a space', () => {
    expect(parseReference('@src/my file.ts')).toBeNull();
  });
});

describe('writing one reference', () => {
  it('writes our own form and only ours', () => {
    expect(formatReference(file('src/a.ts'))).toBe('@src/a.ts');
    expect(formatReference(file('src/a.ts', 12))).toBe('@src/a.ts:12');
    expect(formatReference(file('src/a.ts', 12, 40))).toBe('@src/a.ts:12-40');
    expect(formatReference({ path: 'src', line: null, endLine: null, kind: 'folder' })).toBe('@src/');
  });

  it('writes a range of one line as one line', () => {
    expect(formatReference(file('src/a.ts', 12, 12))).toBe('@src/a.ts:12');
  });

  it('quotes a path that holds a space', () => {
    expect(formatReference(file('a path/with spaces.ts', 3))).toBe('@"a path/with spaces.ts:3"');
  });

  it('draws without the @, because the badge already says it is a file', () => {
    expect(referenceLabel(file('src/a.ts', 3, 9))).toBe('src/a.ts:3-9');
    expect(referenceLabel({ path: 'src', line: null, endLine: null, kind: 'folder' })).toBe('src/');
    expect(referenceLabel(file('a path/with spaces.ts'))).toBe('a path/with spaces.ts');
  });
});

describe('a reference read and written again', () => {
  it('comes back the same when it was already our own form', () => {
    for (const written of [
      '@src/a.ts',
      '@src/a.ts:12',
      '@src/a.ts:12-40',
      '@src/',
      '@/home/me/notes.md:3',
      '@"a path/with spaces.ts:3"',
    ]) {
      expect(formatReference(parseReference(written)!)).toBe(written);
    }
  });

  it('comes back as our form when it was written as somebody else’s', () => {
    expect(formatReference(parseReference('@src/a.ts#L12-L40')!)).toBe('@src/a.ts:12-40');
    expect(formatReference(parseReference('@src/a.ts#12')!)).toBe('@src/a.ts:12');
    expect(formatReference(parseReference('@src/a.ts:12:7')!)).toBe('@src/a.ts:12');
  });
});

describe('where a reference is on disk', () => {
  const where = { cwd: '/home/me/project', home: '/home/me' };

  it('hangs a relative path on the folder it was written in', () => {
    expect(resolveReference(parseReference('@src/a.ts:3')!, where)).toBe('/home/me/project/src/a.ts');
    expect(resolveReference(parseReference('@src/')!, where)).toBe('/home/me/project/src');
  });

  it('takes a plain folder as the root', () => {
    expect(resolveReference(parseReference('@src/a.ts')!, '/home/me/project')).toBe(
      '/home/me/project/src/a.ts',
    );
  });

  it('leaves an address that is already absolute where it is', () => {
    expect(resolveReference(parseReference('@/etc/hosts')!, where)).toBe('/etc/hosts');
  });

  it('puts home in for ~, when home is known', () => {
    expect(resolveReference(parseReference('@~/notes.md')!, where)).toBe('/home/me/notes.md');
    expect(resolveReference(parseReference('@~/notes.md')!, { cwd: '/x', home: '' })).toBeNull();
  });

  it('is nothing when there is no folder to hang a relative path on', () => {
    expect(resolveReference(parseReference('@src/a.ts')!, { cwd: '', home: '' })).toBeNull();
  });
});
