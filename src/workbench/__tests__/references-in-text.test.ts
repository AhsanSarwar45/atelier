/**
 * Finding the references written into a run of text, and leaving alone the
 * things that only look like them.
 *
 * The spans matter as much as the references do: the composer replaces exactly
 * those characters with a badge, so a span that is one character out eats a
 * space or leaves a stray `@` behind (bw-gr8y.2).
 */
import { describe, expect, it } from 'vitest';

import { findReferences } from '@/workbench/references';

const raws = (text: string) => findReferences(text).map((r) => r.raw);

describe('the references in a run of text', () => {
  it('finds one written in the middle of a sentence', () => {
    const text = 'Look at @src/a.ts:3-9 and tell me.';
    const [found] = findReferences(text);
    expect(found).toMatchObject({ path: 'src/a.ts', line: 3, endLine: 9, kind: 'file' });
    expect(text.slice(found!.start, found!.end)).toBe('@src/a.ts:3-9');
    expect(found!.raw).toBe('@src/a.ts:3-9');
  });

  it('finds one at the very start, and one after a bracket', () => {
    expect(raws('@src/a.ts is the file (@src/b.ts:4 is the other)')).toEqual([
      '@src/a.ts',
      '@src/b.ts:4',
    ]);
  });

  it('finds every one in the order it was written', () => {
    expect(raws('@a.ts, @b/ and @c.ts#L2-L8 all changed.')).toEqual(['@a.ts', '@b/', '@c.ts#L2-L8']);
  });

  it('leaves the sentence’s punctuation out of the span', () => {
    const [found] = findReferences('It is in @src/a.ts:12, near the top.');
    expect(found!.raw).toBe('@src/a.ts:12');
  });

  it('leaves an email address alone', () => {
    expect(raws('Ask someone@example.com about it.')).toEqual([]);
  });

  it('leaves a lone @ alone', () => {
    expect(raws('Email me @ home about it.')).toEqual([]);
  });

  it('leaves a scoped package alone, because the @ is inside a path', () => {
    expect(raws('It lives in node_modules/@types/node.')).toEqual([]);
  });

  it('leaves a reference quoted in code alone', () => {
    expect(raws('Type `@src/a.ts:3` into the box.')).toEqual([]);
  });

  it('leaves a reference in a fenced block alone', () => {
    expect(raws('Like this:\n\n```\n@src/a.ts:3\n```\n\nsee?')).toEqual([]);
  });

  it('still finds the ones outside the code around them', () => {
    expect(raws('`@a.ts` is how you write @b.ts:2.')).toEqual(['@b.ts:2']);
  });

  it('finds a quoted path with a space in it', () => {
    const [found] = findReferences('Open @"my notes/a file.md:3" now.');
    expect(found).toMatchObject({ path: 'my notes/a file.md', line: 3 });
    expect(found!.raw).toBe('@"my notes/a file.md:3"');
  });

  it('stops an unquoted path at the first space', () => {
    const [found] = findReferences('Open @my notes/a file.md now.');
    expect(found!.raw).toBe('@my');
  });

  it('finds nothing in a text with no @ in it', () => {
    expect(raws('The fix is in src/workbench/paths.ts:42.')).toEqual([]);
  });
});
