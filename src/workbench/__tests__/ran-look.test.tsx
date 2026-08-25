/**
 * Every kind of thing an agent does has a mark of its own and a colour that
 * survives the build, in every skin.
 *
 * Three things go wrong here and all three are silent. A kind added next door
 * arrives with no mark and draws nothing. A colour nobody spelled out is never
 * built, which is how the board's own state colours went grey (bw-ufso.2). And
 * a skin can quietly give two of the eight bands the same value — `--status-open`
 * already IS `--info` in all ten of them, and `--blocked-accent` IS `--danger`
 * in three — which would leave two bands the reader cannot tell apart while
 * every other check stayed green.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render } from '@testing-library/react';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { describe, expect, it } from 'vitest';

import { colourOfBand, lookOfRan, markOfRan, RAN_BANDS, type RanBand } from '@/workbench/ran-look';
import { RAN_KINDS } from '@/workbench/said-what-it-ran';

import config from '../../../tailwind.config';

describe('every kind is drawn', () => {
  it('gives every kind a mark, and no two kinds the same one', () => {
    const marks = new Set(RAN_KINDS.map((k) => markOfRan(k)));
    expect(marks.size).toBe(RAN_KINDS.length);
    expect(RAN_KINDS.filter((k) => !markOfRan(k))).toEqual([]);
  });

  it('draws every one of them', () => {
    // A name that is exported but not a component would pass the count above
    // and draw an empty row on the screen.
    for (const kind of RAN_KINDS) {
      const Mark = markOfRan(kind);
      const { container, unmount } = render(<Mark className="h-3 w-3" />);
      expect(container.querySelector('svg'), kind).toBeTruthy();
      unmount();
    }
  });

  it('puts every kind in one of the eight bands, and leaves none of them empty', () => {
    const used = new Set<RanBand>(RAN_KINDS.map((k) => lookOfRan(k).band));
    expect(RAN_KINDS.filter((k) => !RAN_BANDS.includes(lookOfRan(k).band))).toEqual([]);
    expect(RAN_BANDS.filter((b) => !used.has(b))).toEqual([]);
  });

  it('gives every band a colour no other band has', () => {
    const colours = new Set(RAN_BANDS.map((b) => colourOfBand(b)));
    expect(colours.size).toBe(RAN_BANDS.length);
  });

  it('puts a delete, a gate and a look in three colours that are not the same', () => {
    // The whole point. These were one grey row each and read as the same event.
    expect(lookOfRan('grave').band).toBe('deleting');
    expect(lookOfRan('test').band).toBe('gates');
    expect(lookOfRan('read').band).toBe('looking');
    const three = new Set([lookOfRan('grave').mark, lookOfRan('test').mark, lookOfRan('read').mark]);
    expect(three.size).toBe(3);
  });

  it('keeps a delete red wherever the deleting happened', () => {
    // A delete is the one row that must never be quiet, and it is one kind, so
    // there is exactly one place this can be got wrong.
    expect(lookOfRan('grave').mark).toBe('text-danger');
  });
});

/** A class as it appears in the stylesheet: an opacity's slash is escaped. */
const selector = (cls: string): string => '.' + cls.replace(/[/:]/g, (c) => '\\' + c);

/** Every class every kind asks Tailwind for. */
const classesAsked = (): string[] =>
  RAN_KINDS.flatMap((k) => lookOfRan(k).mark.split(/\s+/)).filter(Boolean);

async function build(content: string[]): Promise<string> {
  const out = await postcss([tailwind({ ...config, content })]).process('@tailwind utilities;', { from: undefined });
  return out.css;
}

/** Every colour a band names, and so every colour a skin owes. */
const TOKENS = [
  '--danger',
  '--warning',
  '--success',
  '--epic',
  '--info',
  '--text-secondary',
  '--text-tertiary',
  '--text-muted',
];

/** Each palette in a stylesheet: its selector, and what it sets, brace to brace. */
function blocksOf(css: string, opener: RegExp): { name: string; body: string }[] {
  return Array.from(css.matchAll(opener)).map((m) => {
    const from = m.index! + m[0].length;
    return { name: m[0].slice(0, -1).trim(), body: css.slice(from, css.indexOf('}', from)) };
  });
}

/** What a block sets a token to, with the whitespace taken out. */
const valueOf = (body: string, token: string): string | null => {
  const found = new RegExp(`${token}:\\s*([^;]+);`).exec(body);
  return found ? found[1]!.trim().replace(/\s+/g, ' ') : null;
};

describe('the colours survive the build', () => {
  it('builds every class every kind asks for', async () => {
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
    // Red must be red in every skin, which it is only if the band asks for a
    // token the skin itself sets rather than a colour of its own.
    const base = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8');
    const skins = blocksOf(readFileSync(resolve(__dirname, '../../app/themes.css'), 'utf8'),
                           /html\[data-theme="[a-z-]+"\]\s*\{/g);
    // A guard on the reading: a rename over there that matched nothing would
    // otherwise leave this passing on an empty list.
    expect(skins.length).toBeGreaterThan(5);
    expect(TOKENS.filter((t) => !base.includes(`${t}:`))).toEqual([]);
    const short = skins.filter((b) => TOKENS.some((t) => !valueOf(b.body, t))).map((b) => b.name);
    expect(short).toEqual([]);
  });

  it('keeps the eight apart in every skin, so no two bands come out the same colour', () => {
    // Four pairs of this app's tokens are already the same value in all ten
    // skins — `--status-open` is `--info`, `--status-review` is `--epic`,
    // `--status-progress` is `--warning`, `--status-closed` is `--success` —
    // and `--blocked-accent` is `--danger` in three of them. Picking eight
    // names is not the same as picking eight colours, and this is the check
    // that turned nine names into eight colours.
    const skins = blocksOf(readFileSync(resolve(__dirname, '../../app/themes.css'), 'utf8'),
                           /html\[data-theme="[a-z-]+"\]\s*\{/g);
    expect(skins.length).toBeGreaterThan(5);
    const doubled: string[] = [];
    for (const skin of skins) {
      const values = TOKENS.map((t) => valueOf(skin.body, t));
      if (new Set(values).size !== TOKENS.length) doubled.push(skin.name);
    }
    expect(doubled).toEqual([]);
  });

  it('goes red on a skin that gives two bands one colour', () => {
    // The check above, run against a skin written to fail it.
    const rigged = TOKENS.map((t) => `${t}: 0 0% 50%;`).join(' ');
    const skins = blocksOf(`html[data-theme="rigged"] { ${rigged} }`, /html\[data-theme="[a-z-]+"\]\s*\{/g);
    const values = TOKENS.map((t) => valueOf(skins[0]!.body, t));
    expect(new Set(values).size).not.toBe(TOKENS.length);
  });
});
