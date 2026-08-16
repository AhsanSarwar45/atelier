/**
 * One set of parts on the project screen.
 *
 * The manager's rule, 2026-08-16: the app uses components defined in one place
 * instead of every piece of UI redrawing them. This reads the files the project
 * screen is made of and fails on a chip or a panel spelled out by hand, because
 * that is how they drift — a chip 1px taller here, a panel with a different
 * border there, and the screen stops looking like one thing.
 *
 * Design: docs/designs/app-shell.md.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every screen in the app, which is every drawing file that is not one of the
 * parts themselves. `src/components/ui/` is the library: it is where a chip and
 * a panel are allowed to be spelled out, and nowhere else is.
 */
function screens(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'ui' || entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(path);
      } else if (entry.name.endsWith('.tsx')) {
        found.push(path);
      }
    }
  };
  walk('src');
  return found.sort();
}

const SCREEN = screens();

/** A pill of text: rounded, padded, and smaller than the prose around it. */
const CHIP = /rounded[\w-]*/.source;
const SMALL = /text-(xs|\[1[01]px\]|\[0\.6\d*rem\])/;

/** A boxed piece of content: rounded, bordered, on a surface of its own. */
function looksLikeChip(cls: string): boolean {
  // A chip carries its own fill or edge. A row that only lights up under the
  // pointer is a row, and it has no part to come from.
  const filled = /(^|\s)(bg-(?!transparent)|border\b)/.test(cls);
  return new RegExp(CHIP).test(cls) && /\bpx-[\d.[]/.test(cls) && SMALL.test(cls) && filled;
}

function looksLikePanel(cls: string): boolean {
  return /rounded-md/.test(cls) && /\bborder\b/.test(cls) && /\bbg-(?!transparent)/.test(cls);
}

/**
 * Every className string in a file, with the line it sits on and the element it
 * dresses. A capitalised element is a part being composed — passing a class to
 * `Badge` is using the part, not redrawing it — so only the plain HTML ones can
 * offend.
 */
function classNames(source: string): { line: number; cls: string; tag: string }[] {
  const found: { line: number; cls: string; tag: string }[] = [];
  let tag = '';
  source.split('\n').forEach((text, i) => {
    const opening = /<([A-Za-z][\w.]*)/g;
    let o: RegExpExecArray | null;
    while ((o = opening.exec(text)) !== null) tag = o[1]!;
    const quoted = /'([^']*)'|"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = quoted.exec(text)) !== null) {
      const cls = m[1] ?? m[2] ?? '';
      if (cls.includes(' ') || cls.startsWith('rounded')) found.push({ line: i + 1, cls, tag });
    }
  });
  return found;
}

/** A field the reader types into, which is `Input` or `Textarea` and nothing else. */
function looksLikeField(cls: string): boolean {
  return /\bborder\b/.test(cls) && /\bbg-/.test(cls) && /\bpx-\d/.test(cls);
}

/** Plain HTML only: a class handed to a part is composing it, not redrawing it. */
const PLAIN = /^[a-z]/;

function handDrawn(file: string): string[] {
  const source = readFileSync(join(process.cwd(), file), 'utf8');
  return classNames(source)
    .filter(({ tag }) => PLAIN.test(tag))
    .filter(({ cls, tag }) =>
      /^(textarea|input)$/.test(tag)
        ? looksLikeField(cls)
        : looksLikeChip(cls) || looksLikePanel(cls),
    )
    .map(({ line, cls, tag }) => `${file}:${line}  <${tag}>  ${cls}`);
}

describe('one set of parts', () => {
  it('knows a hand-drawn chip and a hand-drawn panel when it sees one', () => {
    expect(looksLikeChip('rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-foreground')).toBe(true);
    expect(looksLikePanel('rounded-md border border-border/60 bg-muted/30 px-3 py-2')).toBe(true);
    expect(looksLikeField('rounded-md border border-b-strong bg-surface-overlay/50 px-3 py-2 text-sm')).toBe(true);
    // What the parts themselves are made of is not a finding: a button is not a
    // chip, and prose is not a panel.
    expect(looksLikeChip('h-8 px-3 text-sm font-medium rounded-md')).toBe(false);
    expect(looksLikePanel('flex items-center gap-2 px-4 py-2')).toBe(false);
  });

  it('reads the element, so dressing a part is not redrawing it', () => {
    const composed = classNames('<Badge className="rounded-sm px-1.5 text-[11px]" />');
    expect(composed[0]!.tag).toBe('Badge');
    const drawn = classNames('<span className="rounded-sm px-1.5 text-[11px]" />');
    expect(drawn[0]!.tag).toBe('span');
  });

  it('finds none anywhere in the app', () => {
    const offenders = SCREEN.flatMap(handDrawn);
    expect(offenders, `use Badge, Panel, Input or Textarea instead of drawing these:\n${offenders.join('\n')}`).toEqual([]);
  });
});
