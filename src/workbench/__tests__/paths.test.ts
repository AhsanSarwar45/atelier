/**
 * What counts as a file named in a chat, and what is only shaped like one.
 *
 * The whole risk in bw-khe.13 is the second kind: prose is full of `and/or` and
 * `24/7`, agents quote versions and web addresses, and every one of them has
 * the shape of an address. Getting those wrong turns a transcript into a field
 * of blue and puts a question to disk on every word.
 */
import { describe, expect, it } from 'vitest';

import { askableIn, candidatesIn, pathsIn, resolvePath, type OnDisk, type Rooted } from '@/workbench/paths';

const WHERE: Rooted = { cwd: '/home/someone/project', home: '/home/someone' };

/** A disk where everything asked about is really there. */
const ALL: OnDisk = { real: () => true };
/** A disk where only these are. */
const only = (...paths: string[]): OnDisk => ({ real: (p) => paths.includes(p) });

const raws = (text: string) => candidatesIn(text).map((c) => c.raw);

describe('what has the shape of an address', () => {
  it('finds one written from the root', () => {
    expect(raws('see /home/someone/project/src/main.rs for it')).toEqual([
      '/home/someone/project/src/main.rs',
    ]);
  });

  it('finds one written from inside the project', () => {
    expect(raws('the fix is in src/workbench/paths.ts')).toEqual(['src/workbench/paths.ts']);
  });

  it('finds one written against home', () => {
    expect(raws('~/dev/beads-web/README.md is the one')).toEqual(['~/dev/beads-web/README.md']);
  });

  it('finds ./ and ../ for what they are', () => {
    expect(raws('run ./scripts/build.sh then ../other/thing.py')).toEqual([
      './scripts/build.sh',
      '../other/thing.py',
    ]);
  });

  it('finds every folder a command opens with', () => {
    expect(raws('cd /home/dev/beads-web/worktrees/bw-1p2 && grep -rn "x" src/lib/api.ts')).toEqual([
      '/home/dev/beads-web/worktrees/bw-1p2',
      'src/lib/api.ts',
    ]);
  });

  it('does not read a bare word with a slash as a file', () => {
    expect(raws('either and/or, about 24/7, w/e')).toEqual([]);
  });

  it('does not read a version or a date as a file', () => {
    expect(raws('version 1.5.0, released 2026-08-20')).toEqual([]);
  });

  it('leaves a web address alone', () => {
    expect(raws('see https://github.com/gastownhall/beads/blob/main/docs/x.md for it')).toEqual([]);
  });

  it('does not cut a rooted address out of the middle of a word', () => {
    // `/b.ts` sits inside this, and reading it as an address of its own would
    // ask disk about a file at the root that nobody wrote.
    expect(raws('zzza/b.ts')).toEqual(['zzza/b.ts']);
  });
});

describe('what the sentence around it adds', () => {
  it('drops the full stop that ends the sentence', () => {
    expect(raws('it lives in src/lib/api.ts.')).toEqual(['src/lib/api.ts']);
  });

  it('drops a closing bracket and a comma', () => {
    expect(raws('(src/lib/api.ts), and more')).toEqual(['src/lib/api.ts']);
  });

  it('keeps a line number and leaves it off the name', () => {
    const [found] = candidatesIn('src/workbench/chat-tab.tsx:212 is the row');
    expect(found).toMatchObject({ raw: 'src/workbench/chat-tab.tsx', line: 212 });
  });

  it('reads a line and a column, and opens on the line', () => {
    const [found] = candidatesIn('src/lib/api.ts:42:7 there');
    expect(found).toMatchObject({ raw: 'src/lib/api.ts', line: 42 });
  });

  it('has no line when none was written', () => {
    expect(candidatesIn('src/lib/api.ts')[0]!.line).toBeNull();
  });
});

describe('where a written address actually points', () => {
  it('leaves a rooted one where it is', () => {
    expect(resolvePath('/a/b/c.ts', WHERE)).toBe('/a/b/c.ts');
  });

  it('hangs a relative one on the folder that chat ran in', () => {
    expect(resolvePath('src/lib/api.ts', WHERE)).toBe('/home/someone/project/src/lib/api.ts');
  });

  it('reads ~ as the reader’s home', () => {
    expect(resolvePath('~/dev/x.md', WHERE)).toBe('/home/someone/dev/x.md');
  });

  it('walks ./ and ../ out of the way', () => {
    expect(resolvePath('./src/./a.ts', WHERE)).toBe('/home/someone/project/src/a.ts');
    expect(resolvePath('../other/b.ts', WHERE)).toBe('/home/someone/other/b.ts');
  });

  it('cannot place a relative one with no folder to hang it on', () => {
    expect(resolvePath('src/a.ts', { cwd: '', home: '/home/someone' })).toBeNull();
  });

  it('cannot place a ~ one before home is known', () => {
    expect(resolvePath('~/a.ts', { cwd: '/x', home: '' })).toBeNull();
  });
});

describe('what becomes a chip', () => {
  it('splits the words around a file that is really there', () => {
    expect(pathsIn('the fix is in src/lib/api.ts now', WHERE, ALL)).toEqual([
      { kind: 'text', text: 'the fix is in ' },
      { kind: 'path', raw: 'src/lib/api.ts', absolute: '/home/someone/project/src/lib/api.ts', line: null },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('leaves a name that is no file on disk as plain words', () => {
    expect(pathsIn('the fix is in src/lib/api.ts now', WHERE, only('/nothing'))).toEqual([
      { kind: 'text', text: 'the fix is in src/lib/api.ts now' },
    ]);
  });

  it('draws the reader’s own words, line and all, not the resolved address', () => {
    const [, chip] = pathsIn('see src/lib/api.ts:42 there', WHERE, ALL);
    expect(chip).toEqual({
      kind: 'path',
      raw: 'src/lib/api.ts:42',
      absolute: '/home/someone/project/src/lib/api.ts',
      line: 42,
    });
  });

  it('hands back text with nothing in it as itself', () => {
    expect(pathsIn('nothing here at all', WHERE, ALL)).toEqual([{ kind: 'text', text: 'nothing here at all' }]);
  });

  it('finds several in one command', () => {
    const pieces = pathsIn('cp src/a.ts src/b.ts', WHERE, ALL);
    expect(pieces.filter((p) => p.kind === 'path')).toHaveLength(2);
  });
});

describe('what to go and ask disk about', () => {
  it('resolves every candidate once', () => {
    expect(askableIn('src/a.ts and src/a.ts and /tmp/b.ts', WHERE)).toEqual([
      '/home/someone/project/src/a.ts',
      '/tmp/b.ts',
    ]);
  });

  it('asks about nothing when there is nothing shaped like a file', () => {
    expect(askableIn('and/or, 24/7, version 1.5.0', WHERE)).toEqual([]);
  });
});
