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

import { fireEvent, render, screen } from '@testing-library/react';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { describe, expect, it } from 'vitest';

import { MachineLine } from '@/workbench/transcript-rows';
import {
  drawnRows,
  familyOf,
  FAMILIES,
  forWhom,
  KINDS_WITH_AN_AUDIENCE,
  KNOWN_KINDS,
  saidBy,
  type MachineFamily,
} from '@/workbench/machine-lines';
import { lookOf, markOf } from '@/workbench/machine-look';
import { SAID_NOTHING } from '@/workbench/machine-words';
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

/** Something the chat itself said — nobody sent it off, so it hangs off nothing. */
const said = (text: string): TranscriptItem => ({
  kind: 'message',
  id: `msg-${text}`,
  role: 'assistant',
  text,
  images: [],
  done: true,
  parentId: null,
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
  // A kind the driver deliberately draws nothing for needs no family and no
  // reader: the silence is itself a ruling, written down beside the words
  // (src/workbench/machine-words.ts, bw-iiv6).
  const silent = Object.keys(SAID_NOTHING);
  return Array.from(new Set([...cases, ...byHand])).filter((kind) => !silent.includes(kind));
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
    const chips = new Set(FAMILIES.map((f) => lookOf(f).row));
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

  it('says who every kind the driver can emit is for', () => {
    // Unnamed here means nobody has ruled on it, and it falls to the machine's
    // side — where a chat does not draw it. That is the right default and the
    // wrong place to arrive by accident, so this goes red instead (bw-6jq5).
    const found = kindsTheDriverEmits();
    expect(found.filter((kind) => !KINDS_WITH_AN_AUDIENCE.includes(kind))).toEqual([]);
  });

  it('separates who a line is for from how bad it is', () => {
    // The two axes disagree on purpose, in both directions. A hook that refused
    // the turn is loud and is still the machine's own business; an agent coming
    // home fine is quiet news and so is the machine's; an agent that FAILED is
    // his (the manager's ruling of 2026-08-20).
    expect(familyOf('system/hook_response', 'note')).toBe('failed');
    expect(forWhom('system/hook_response', 'note')).toBe('machine');
    expect(forWhom('system/task_started', 'detail')).toBe('machine');
    expect(forWhom('system/task_notification', 'detail')).toBe('machine');
    expect(forWhom('system/task_notification', 'note')).toBe('you');
    // His allowance: nothing to do while the window is open, everything to do
    // once it has closed.
    expect(forWhom('rate_limit_event', 'detail')).toBe('machine');
    expect(forWhom('rate_limit_event', 'note')).toBe('you');
  });

  it('keeps a kind nobody has ruled on off his screen, not out of the record', () => {
    expect(forWhom('system/something_new', 'note')).toBe('machine');
    expect(forWhom('system/something_new', 'detail')).toBe('machine');
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
    const rows = drawnRows(items);
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
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.row === 'machine' ? r.family : 'other'))).toEqual(['waiting', 'memory']);
  });

  it('does not fold across what was said in between', () => {
    const rows = drawnRows(
      [note('system/api_retry', 'Retrying (1 of 5)'), said('Back on it.'), note('system/api_retry', 'Retrying (2 of 5)')],
    );
    expect(rows.map((r) => r.row)).toEqual(['machine', 'other', 'machine']);
  });

  it('draws a quiet line where it happened, between two halves of a run', () => {
    // Nothing is held back for being quiet any more, so a ping in the middle of
    // a run is on the page and the run either side of it is two chips. Reading
    // it as one again is what switching that family off is for (bw-jkh2.13).
    const rows = drawnRows(
      [
        note('system/api_retry', 'Retrying (1 of 5)'),
        note('system/status', 'Status: requesting', 'detail'),
        note('system/api_retry', 'Retrying (2 of 5)'),
      ],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => (r.row === 'machine' ? r.family : 'other'))).toEqual([
      'waiting',
      'breathing',
      'waiting',
    ]);
  });

  it('draws a quiet line without being asked to', () => {
    const rows = drawnRows([note('system/status', 'Status: requesting', 'detail')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ row: 'machine', family: 'breathing' });
  });
});

/** A message as it arrives from the chat: his own, or one written in his name. */
const typed = (text: string): TranscriptItem => ({
  kind: 'message',
  id: `typed-${text}`,
  role: 'user',
  text,
  parentId: null,
  images: [],
  done: true,
});

describe('a line the kit wrote in his name', () => {
  it('is the machine talking, and never his own message', () => {
    const rows = drawnRows([typed('[Request interrupted by user]')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ row: 'machine', family: 'stopped', kind: 'user/synthetic' });
    expect(rows.some((r) => r.row === 'other')).toBe(false);
  });

  it('leaves what he really typed alone', () => {
    const rows = drawnRows([typed('do the thing'), typed('see [the note] about it')]);
    expect(rows.map((r) => r.row)).toEqual(['other', 'other']);
  });

  it('folds a run of them the way it folds any other kind', () => {
    const rows = drawnRows([typed('[Request interrupted by user]'), typed('[Request interrupted by user for tool use]')]);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Extract<(typeof rows)[number], { row: 'machine' }>;
    expect(row.lines).toHaveLength(2);
  });
});

describe('an app aside is a chip too', () => {
  it('takes the family the sidecar gave it', () => {
    const rows = drawnRows([aside('12 earlier messages … are not drawn here.', 'memory')]);
    expect(rows[0]).toMatchObject({ row: 'machine', family: 'memory', kind: 'app/notice' });
  });

  it('is the app speaking when it was recorded before there were families', () => {
    const rows = drawnRows([aside('Continuing this chat.')]);
    expect(rows[0]).toMatchObject({ row: 'machine', family: 'background' });
  });

  it('does not fold two asides meant for different families', () => {
    // Every aside arrives under the one kind and carries its family beside it,
    // so kind and loudness alone would merge these and draw the second one's
    // words in the first one's colour.
    const rows = drawnRows([aside('one', 'memory'), aside('two', 'background')]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.row === 'machine' ? r.family : 'other'))).toEqual(['memory', 'background']);
  });

  it('keeps every chip wearing the colour of the words it shows', () => {
    const rows = drawnRows(
      [aside('one', 'memory'), aside('two', 'background'), aside('three', 'background')],
    );
    for (const row of rows) {
      if (row.row !== 'machine') continue;
      const shown = row.lines[row.lines.length - 1]!.text;
      const meant = { one: 'memory', two: 'background', three: 'background' }[shown];
      expect(row.family).toBe(meant);
    }
  });

  it('folds with the aside beside it, and not with a note', () => {
    const rows = drawnRows(
      [aside('one', 'memory'), aside('two', 'memory'), note('system/api_retry', 'Retrying (1 of 5)')],
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
    return [look.row, look.count].join(' ').split(/\s+/);
  }).filter(Boolean);

async function build(content: string[]): Promise<string> {
  const out = await postcss([tailwind({ ...config, content })]).process('@tailwind utilities;', { from: undefined });
  return out.css;
}

/** Every colour a family names, and so every colour a skin owes. */
const TOKENS = ['--warning', '--danger', '--status-review', '--epic', '--info', '--text-faint'];

/** Each palette in a stylesheet: its selector, and what it sets, brace to brace. */
function blocksOf(css: string, opener: RegExp): { name: string; body: string }[] {
  return Array.from(css.matchAll(opener)).map((m) => {
    const from = m.index! + m[0].length;
    return { name: m[0].slice(0, -1).trim(), body: css.slice(from, css.indexOf('}', from)) };
  });
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
    // Red must be red in every skin, which it is only if the family asks for a
    // token the skin itself sets rather than a colour of its own.
    //
    // Read out of the file the named skins live in, and block by block: the
    // earlier version of this read only globals.css, whose own two blocks
    // satisfied it whatever the named skins did — it would have stayed green
    // with themes.css deleted (bw-jkh2.9).
    const base = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8');
    const skins = blocksOf(readFileSync(resolve(__dirname, '../../app/themes.css'), 'utf8'),
                           /html\[data-theme="[a-z-]+"\]\s*\{/g);
    // A guard on the reading: a rename over there that matched nothing would
    // otherwise leave this passing on an empty list.
    expect(skins.length).toBeGreaterThan(5);
    // The colours a skin does not touch fall through to the ones underneath, so
    // the base owes all six and no skin may set only some of them.
    expect(TOKENS.filter((t) => !base.includes(`${t}:`))).toEqual([]);
    const short = skins.filter((b) => TOKENS.some((t) => !b.body.includes(`${t}:`))).map((b) => b.name);
    expect(short).toEqual([]);
  });
});

/** The row as the transcript hands it over. */
const machineRow = (items: TranscriptItem[]) => {
  const row = drawnRows(items)[0]!;
  if (row.row !== 'machine') throw new Error('not a machine row');
  return row;
};

describe('the chat draws them as rows', () => {
  it('carries its family, its mark and what it said', () => {
    render(<MachineLine row={machineRow([note('user/synthetic', '[Request interrupted by user]')])} />);
    const row = screen.getByTestId('note-row');
    expect(row).toHaveAttribute('data-family', 'stopped');
    expect(row).toHaveAttribute('data-note-kind', 'user/synthetic');
    // The colour is on the row, the way a command's is, not on the button.
    expect(screen.getByTestId('note-row').querySelector('[class*="text-warning"]')).toBeTruthy();
    // And it is the same full-width row a command draws in, never centred.
    expect(screen.getByTestId('note-row').className).not.toContain('items-center');
    expect(row.querySelector('svg')).toBeTruthy();
    expect(row.textContent).toContain('[Request interrupted by user]');
  });

  it('says how many times a folded run happened, and only then', () => {
    const many = Array.from({ length: 8 }, (_, i) => note('system/api_retry', `Retrying (${i + 1} of 8)`));
    const { unmount } = render(<MachineLine row={machineRow(many)} />);
    expect(screen.getByTestId('note-times').textContent).toBe('8');
    expect(screen.getByTestId('note-row')).toHaveAttribute('data-times', '8');
    unmount();

    render(<MachineLine row={machineRow([note('system/api_retry', 'Retrying (1 of 5)')])} />);
    expect(screen.queryByTestId('note-times')).toBeNull();
  });

  it('hands over every folded line once it is opened', () => {
    const many = Array.from({ length: 3 }, (_, i) => note('system/api_retry', `Retrying (${i + 1} of 3)`));
    render(<MachineLine row={machineRow(many)} />);
    expect(screen.queryAllByTestId('note-body')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('note-toggle'));
    expect(screen.getAllByTestId('note-body')).toHaveLength(3);
  });

  it('does not open a single line with nothing behind it', () => {
    render(<MachineLine row={machineRow([note('conversation_reset', 'This chat was started over.')])} />);
    expect(screen.getByTestId('note-toggle')).toBeDisabled();
  });
});
