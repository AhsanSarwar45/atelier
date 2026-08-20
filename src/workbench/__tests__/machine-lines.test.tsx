/**
 * Every machine message has a family, that family reaches the screen, and a run
 * of one kind is drawn once.
 *
 * The four things this holds are the four ways the old grey line failed: a kind
 * nobody sorted fell through to grey, a colour nobody spelled out never got
 * built, a bad hour on a busy service filled the page with near-identical lines,
 * and the app's own asides were a second shape unlike everything around them
 * (bw-jkh2).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { describe, expect, it } from 'vitest';

import { MachineLine } from '@/workbench/transcript-rows';
import {
  drawnRows,
  familyOf,
  FAMILIES,
  KNOWN_KINDS,
  lookOf,
  markOf,
  saidBy,
  type MachineFamily,
} from '@/workbench/machine-lines';
import type { NoteRank } from '@/workbench/protocol';
import type { TranscriptItem } from '@/workbench/use-session';

import config from '../../../tailwind.config';

/** One note as the reducer stores it. */
const note = (kind: string, text: string, rank: NoteRank = 'note'): TranscriptItem => ({
  kind: 'note',
  id: `note-${kind}-${text}`,
  rank,
  noteKind: kind,
  text,
  body: null,
});

/** One of the app's own asides. */
const aside = (text: string, family?: MachineFamily): TranscriptItem => ({
  kind: 'notice',
  id: `notice-${text}`,
  text,
  family,
});

const said = (text: string): TranscriptItem => ({
  kind: 'message',
  id: `msg-${text}`,
  role: 'assistant',
  text,
  images: [],
  done: true,
});

/**
 * Every kind the driver can put on the wire, read out of the driver itself.
 *
 * Read rather than listed, because a list here would go stale the first time a
 * kind is added over there and the new one would land in grey without anything
 * going red.
 */
function kindsTheDriverEmits(): string[] {
  const source = readFileSync(resolve(__dirname, '../../../workbench/src/drivers/claude.ts'), 'utf8');
  // The sorting function's own branches, and the lines the driver writes by
  // hand elsewhere. Nothing else in the file names a machine message.
  const sorter = source.slice(source.indexOf('function noteBody('));
  const cases = Array.from(sorter.slice(0, sorter.indexOf('\n}\n')).matchAll(/case '([\w/_]+)':/g)).map((m) => m[1]!);
  const byHand = Array.from(source.matchAll(/this\.note\(\{[^}]*\bkind: '([\w/_]+)'/g)).map((m) => m[1]!);
  return Array.from(new Set([...cases, ...byHand]));
}

describe('every kind has a family', () => {
  it('sorts every kind the driver can emit, with none falling through', () => {
    const found = kindsTheDriverEmits();
    // A guard on the reading itself: a rename over there that matched nothing
    // would otherwise leave this passing on an empty list.
    expect(found.length).toBeGreaterThan(15);
    expect(found.filter((kind) => !KNOWN_KINDS.includes(kind))).toEqual([]);
  });

  it('gives every family a colour and a mark of its own', () => {
    const marks = new Set(FAMILIES.map((f) => markOf(f)));
    const chips = new Set(FAMILIES.map((f) => lookOf(f).chip));
    expect(marks.size).toBe(FAMILIES.length);
    expect(chips.size).toBe(FAMILIES.length);
  });

  it('reads the loudness, not the wording, where one kind means two things', () => {
    // A hook that failed is his to see; one that worked is the machine breathing.
    expect(familyOf('system/hook_response', 'note')).toBe('failed');
    expect(familyOf('system/hook_response', 'detail')).toBe('breathing');
    // The answer to /compact against the status ping on every request.
    expect(familyOf('system/status', 'note')).toBe('memory');
    expect(familyOf('system/status', 'detail')).toBe('breathing');
  });

  it('keeps an unfamiliar kind at the loudness the driver gave it', () => {
    expect(familyOf('system/something_new', 'note')).toBe('background');
    expect(familyOf('system/something_new', 'detail')).toBe('breathing');
  });

  it('puts a stop, a retry and a compaction in three different families', () => {
    // The whole point: these were one grey line each and read as the same event.
    expect(familyOf('user/synthetic', 'note')).toBe('stopped');
    expect(familyOf('system/api_retry', 'note')).toBe('waiting');
    expect(familyOf('system/compact_boundary', 'note')).toBe('memory');
  });
});

describe('a run collapses', () => {
  it('draws eight retries as one chip reading eight', () => {
    const items = Array.from({ length: 8 }, (_, i) => note('system/api_retry', `Retrying (${i + 1} of 8)`));
    const rows = drawnRows(items, false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ row: 'machine', family: 'waiting' });
    const row = rows[0] as Extract<(typeof rows)[number], { row: 'machine' }>;
    expect(row.lines).toHaveLength(8);
    // The chip says where the run had got to, and opening it gives all eight.
    expect(saidBy(row)).toBe('Retrying (8 of 8)');
    expect(row.lines[0]!.text).toBe('Retrying (1 of 8)');
  });

  it('keeps two different kinds as two chips', () => {
    const rows = drawnRows(
      [note('system/api_retry', 'Retrying (1 of 5)'), note('system/compact_boundary', 'Compacted (manual): 90k tokens')],
      false,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.row === 'machine' ? r.family : 'other'))).toEqual(['waiting', 'memory']);
  });

  it('does not fold across what was said in between', () => {
    const rows = drawnRows(
      [note('system/api_retry', 'Retrying (1 of 5)'), said('Back on it.'), note('system/api_retry', 'Retrying (2 of 5)')],
      false,
    );
    expect(rows.map((r) => r.row)).toEqual(['machine', 'other', 'machine']);
  });

  it('drops the quiet lines before folding, not after', () => {
    // A status ping landing mid-run used to cut the run in two and draw the same
    // thing twice with nothing between them.
    const rows = drawnRows(
      [
        note('system/api_retry', 'Retrying (1 of 5)'),
        note('system/status', 'Status: requesting', 'detail'),
        note('system/api_retry', 'Retrying (2 of 5)'),
      ],
      false,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as Extract<(typeof rows)[number], { row: 'machine' }>;
    expect(row.lines).toHaveLength(2);
  });

  it('shows the quiet lines when the reader asks for everything', () => {
    const rows = drawnRows([note('system/status', 'Status: requesting', 'detail')], true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ row: 'machine', family: 'breathing' });
  });
});

describe('an app aside is a chip too', () => {
  it('takes the family the sidecar gave it', () => {
    const rows = drawnRows([aside('12 earlier messages … are not drawn here.', 'memory')], false);
    expect(rows[0]).toMatchObject({ row: 'machine', family: 'memory', kind: 'app/notice' });
  });

  it('is the app speaking when it was recorded before there were families', () => {
    const rows = drawnRows([aside('Continuing this chat.')], false);
    expect(rows[0]).toMatchObject({ row: 'machine', family: 'background' });
  });

  it('folds with the aside beside it, and not with a note', () => {
    const rows = drawnRows(
      [aside('one', 'memory'), aside('two', 'memory'), note('system/api_retry', 'Retrying (1 of 5)')],
      false,
    );
    expect(rows).toHaveLength(2);
    const first = rows[0] as Extract<(typeof rows)[number], { row: 'machine' }>;
    expect(first.lines).toHaveLength(2);
  });
});

/** A class as it appears in the stylesheet: an opacity's slash is escaped. */
const selector = (cls: string): string => '.' + cls.replace(/[/:]/g, (c) => '\\' + c);

/** Every class every family asks Tailwind for. */
const classesAsked = (): string[] =>
  FAMILIES.flatMap((f) => {
    const look = lookOf(f);
    return [look.rule, look.chip, look.count].join(' ').split(/\s+/);
  }).filter(Boolean);

async function build(content: string[]): Promise<string> {
  const out = await postcss([tailwind({ ...config, content })]).process('@tailwind utilities;', { from: undefined });
  return out.css;
}

describe('the colours survive the build', () => {
  it('builds every class every family asks for', async () => {
    // Reasoning about the source is exactly what missed the board's own state
    // colours going grey, so this runs the real Tailwind over the real tree.
    const css = await build(config.content as string[]);
    const missing = classesAsked().filter((c) => !css.includes(selector(c)));
    expect(missing).toEqual([]);
  }, 60_000);

  it('goes red when the file spelling them is out of reach', async () => {
    const css = await build(['./src/app/**/*.{js,ts,jsx,tsx,mdx}']);
    const missing = classesAsked().filter((c) => !css.includes(selector(c)));
    expect(missing.length).toBeGreaterThan(0);
  }, 60_000);

  it('takes its colours from tokens every skin defines', () => {
    // Red must be red in all eleven skins, which it is only if the family asks
    // for a token the skins set rather than a colour of its own.
    const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8');
    const skins = css.split(/\[data-theme=|\.dark\b|:root/).length - 1;
    expect(skins).toBeGreaterThan(1);
    for (const token of ['--warning', '--danger', '--status-review', '--epic', '--info', '--text-faint']) {
      expect(css).toContain(token);
    }
  });
});

/** The row as the transcript hands it over. */
const machineRow = (items: TranscriptItem[]) => {
  const row = drawnRows(items, true)[0]!;
  if (row.row !== 'machine') throw new Error('not a machine row');
  return row;
};

describe('the chat draws them as chips', () => {
  it('carries its family, its mark and what it said', () => {
    render(<MachineLine row={machineRow([note('user/synthetic', '[Request interrupted by user]')])} openAll={false} />);
    const row = screen.getByTestId('note-row');
    expect(row).toHaveAttribute('data-family', 'stopped');
    expect(row).toHaveAttribute('data-note-kind', 'user/synthetic');
    expect(screen.getByTestId('note-toggle').className).toContain('text-warning');
    expect(row.querySelector('svg')).toBeTruthy();
    expect(row.textContent).toContain('[Request interrupted by user]');
  });

  it('says how many times a folded run happened, and only then', () => {
    const many = Array.from({ length: 8 }, (_, i) => note('system/api_retry', `Retrying (${i + 1} of 8)`));
    const { unmount } = render(<MachineLine row={machineRow(many)} openAll={false} />);
    expect(screen.getByTestId('note-times').textContent).toBe('8');
    expect(screen.getByTestId('note-row')).toHaveAttribute('data-times', '8');
    unmount();

    render(<MachineLine row={machineRow([note('system/api_retry', 'Retrying (1 of 5)')])} openAll={false} />);
    expect(screen.queryByTestId('note-times')).toBeNull();
  });

  it('hands over every folded line once it is opened', () => {
    const many = Array.from({ length: 3 }, (_, i) => note('system/api_retry', `Retrying (${i + 1} of 3)`));
    render(<MachineLine row={machineRow(many)} openAll />);
    expect(screen.getAllByTestId('note-body')).toHaveLength(3);
  });

  it('does not open a single line with nothing behind it', () => {
    render(<MachineLine row={machineRow([note('conversation_reset', 'This chat was started over.')])} openAll />);
    expect(screen.getByTestId('note-toggle')).toBeDisabled();
  });
});
