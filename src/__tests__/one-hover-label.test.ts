/**
 * A hover label is the app's, not the browser's (bw-6wq6).
 *
 * There were three ways to say something on hover: `title`, which the browser
 * draws in its own box after its own wait; a Radix tooltip mounted by hand
 * wherever somebody needed one; and a panel the status donut positioned for
 * itself. One gesture, three looks, three speeds, and no one place to change
 * any of it. They are one component now, and the way that came apart was one
 * `title=` at a time — so this is the case that refuses the first of them.
 *
 * It refuses the attribute, not the word. `title` on an `iframe` is what names
 * the frame for a screen reader and HTML has no other way to say it, an
 * `svg` names itself with a `<title>` child element rather than an attribute,
 * and a component of this app's own — `<Section title=…>` — is being handed a
 * prop it draws as a heading, which is not a hover label at all.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx$/.test(name) ? [path] : [];
  });
}

/** The one element HTML gives no other way to name. */
const ALLOWED = new Set(['iframe']);

/**
 * Where a `title=` attribute sits on a plain HTML element rather than on a
 * component of this app's own.
 *
 * The tag an attribute belongs to is the last one opened before it. That is
 * enough to tell `<p title=…>` from `<Section title=…>` — the first is a
 * hover label the browser draws, the second is a prop with a name — and it
 * does not need a parser to say so: an attribute cannot appear before the tag
 * it is written in.
 */
export function hoverTitles(source: string): string[] {
  const found: string[] = [];
  // `title=` with nothing joined to its left: not `data-title=`, and not the
  // `.title` of some object being read.
  const attribute = /(?<![\w.$-])title\s*=/g;
  const opening = /<([A-Za-z][\w.]*)/g;
  const tags: { at: number; name: string }[] = [];
  for (let tag = opening.exec(source); tag; tag = opening.exec(source)) {
    tags.push({ at: tag.index, name: tag[1] });
  }
  for (let hit = attribute.exec(source); hit; hit = attribute.exec(source)) {
    const tag = tags.filter((candidate) => candidate.at < hit!.index).at(-1);
    if (!tag) continue;
    if (!stillInside(source, tag.at, hit.index)) continue;
    const html = tag.name === tag.name.toLowerCase();
    if (html && !ALLOWED.has(tag.name)) found.push(tag.name);
  }
  return found;
}

/**
 * Whether the tag opened at `from` is still open at `at`.
 *
 * Without this a `const title = …` written after the last tag on the page
 * reads as an attribute of it. The tag is closed by the first `>` that is not
 * inside a string or an expression of its own, which is what this walks to.
 */
function stillInside(source: string, from: number, at: number): boolean {
  let braces = 0;
  let quote = '';
  for (let i = from; i < at; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') braces += 1;
    else if (c === '}') braces -= 1;
    else if (c === '>' && braces === 0) return false;
  }
  return true;
}

describe('one hover label', () => {
  it('reads a title attribute as the hover label it is', () => {
    expect(hoverTitles('<span title="Copy this">x</span>')).toEqual(['span']);
    expect(hoverTitles('<div\n  className="chip"\n  title={label}\n/>')).toEqual(['div']);
  });

  it('leaves alone the titles that are not hover labels', () => {
    // A prop with a name, drawn as a heading.
    expect(hoverTitles('<Section title="Staged" />')).toEqual([]);
    // The one element HTML names this way.
    expect(hoverTitles('<iframe src={src} title="A preview" />')).toEqual([]);
    // A picture names itself with an element, not an attribute.
    expect(hoverTitles('<svg><title>A donut</title></svg>')).toEqual([]);
    // And neither a data attribute nor a value being read is one.
    expect(hoverTitles('<a data-title={x} href={href}>{definition.title}</a>')).toEqual([]);
    // And a variable of that name written after the last tag on the page is
    // not an attribute of it.
    expect(hoverTitles('<p>{name}</p>\n\nconst title = [a, b].join(" ");')).toEqual([]);
  });

  it('is the only mechanism the screens use', () => {
    const root = join(process.cwd(), 'src');
    const offenders = sourceFiles(root)
      .filter((path) => !path.includes('__tests__'))
      .flatMap((path) => hoverTitles(readFileSync(path, 'utf8')).map((tag) => `${relative(root, path)}: <${tag} title=…>`));

    expect(offenders, 'a hover label the browser draws; use <Tooltip label={…}> instead').toEqual([]);
  });
});
