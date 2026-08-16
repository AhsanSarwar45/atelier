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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** The screens the manager judges: the shell, the board, the chat. */
const SCREEN = [
  'src/components/shell.tsx',
  'src/app/project/page.tsx',
  'src/app/project/kanban-board.tsx',
  'src/components/kanban-column.tsx',
  'src/components/quick-filter-bar.tsx',
  'src/workbench/chat-sidebar.tsx',
  'src/workbench/chat-tab.tsx',
  'src/workbench/globals.tsx',
  'src/workbench/search-panel.tsx',
  'src/workbench/spend-view.tsx',
];

/** A pill of text: rounded, padded, and smaller than the prose around it. */
const CHIP = /rounded[\w-]*/.source;
const SMALL = /text-(xs|\[1[01]px\]|\[0\.6\d*rem\])/;

/** A boxed piece of content: rounded, bordered, on a surface of its own. */
function looksLikeChip(cls: string): boolean {
  return new RegExp(CHIP).test(cls) && /\bpx-[\d.[]/.test(cls) && SMALL.test(cls);
}

function looksLikePanel(cls: string): boolean {
  return /rounded-md/.test(cls) && /\bborder\b/.test(cls) && /\bbg-(?!transparent)/.test(cls);
}

/** Every className string in a file, with the line it sits on. */
function classNames(source: string): { line: number; cls: string }[] {
  const found: { line: number; cls: string }[] = [];
  source.split('\n').forEach((text, i) => {
    const quoted = /'([^']*)'|"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = quoted.exec(text)) !== null) {
      const cls = m[1] ?? m[2] ?? '';
      if (cls.includes(' ') || cls.startsWith('rounded')) found.push({ line: i + 1, cls });
    }
  });
  return found;
}

function handDrawn(file: string): string[] {
  const source = readFileSync(join(process.cwd(), file), 'utf8');
  return classNames(source)
    .filter(({ cls }) => looksLikeChip(cls) || looksLikePanel(cls))
    .map(({ line, cls }) => `${file}:${line}  ${cls}`);
}

describe('one set of parts', () => {
  it('knows a hand-drawn chip and a hand-drawn panel when it sees one', () => {
    expect(looksLikeChip('rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-foreground')).toBe(true);
    expect(looksLikePanel('rounded-md border border-border/60 bg-muted/30 px-3 py-2')).toBe(true);
    // What the parts themselves are made of is not a finding: a button is not a
    // chip, and prose is not a panel.
    expect(looksLikeChip('h-8 px-3 text-sm font-medium rounded-md')).toBe(false);
    expect(looksLikePanel('flex items-center gap-2 px-4 py-2')).toBe(false);
  });

  it('finds none on the project screen', () => {
    const offenders = SCREEN.flatMap(handDrawn);
    expect(offenders, `use Badge or Panel instead of drawing these:\n${offenders.join('\n')}`).toEqual([]);
  });
});
