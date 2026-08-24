/**
 * Every theme has to be able to draw a button nobody has filled in.
 *
 * The library's outline, ghost and dashed buttons sit on the page and write
 * their label in the ordinary text colour; once they fill — hovered, or held
 * open by the menu under them — the label becomes accent-foreground on the
 * accent. Three of the themes set accent-foreground to exactly their own
 * background, which is right for a filled button and left the resting one
 * writing in invisible ink (bw-jqv9). This reads the themes' own colours and
 * measures both pairings, so a theme added later cannot bring that back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { THEMES } from '../themes';

const ROOT = join(__dirname, '..', '..', '..');
const GLOBALS = readFileSync(join(ROOT, 'src/app/globals.css'), 'utf8');
const THEME_CSS = readFileSync(join(ROOT, 'src/app/themes.css'), 'utf8');

/** The variables declared in the first block a selector opens. */
function block(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  if (at < 0) return {};
  const open = css.indexOf('{', at);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const out: Record<string, string> = {};
  const declarations = css.slice(open, end);
  const rule = /(--[\w-]+)\s*:\s*([^;]+);/g;
  for (let m = rule.exec(declarations); m; m = rule.exec(declarations)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const LIGHT = block(GLOBALS, ':root');
const DARK = block(GLOBALS, '.dark');

/** An `H S% L%` triple, the shape every colour in this app is written in. */
function rgb(value: string): [number, number, number] {
  const [h, s, l] = value.replace(/%/g, '').split(/\s+/).map(Number);
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function contrast(a: string, b: string): number {
  const lum = (v: string) => {
    const [r, g, bb] = rgb(v).map((c) => {
      const n = c / 255;
      return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bb;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** What a theme actually resolves a variable to, falling back the way CSS does. */
function colours(themeId: string, mode: 'dark' | 'light'): Record<string, string> {
  const own = themeId === 'default' ? {} : block(THEME_CSS, `html[data-theme="${themeId}"]`);
  return { ...LIGHT, ...(mode === 'dark' ? DARK : {}), ...own };
}

/** The floor the standard puts under ordinary text. */
const READABLE = 4.5;

describe('a button nobody has filled in still reads, in every theme', () => {
  it.each(THEMES.map((t) => [t.id, t.mode] as const))('%s', (id, mode) => {
    const c = colours(id, mode);
    const resting = contrast(c['--foreground'], c['--background']);
    const filled = contrast(c['--accent-foreground'], c['--accent']);
    expect(
      Number(resting.toFixed(2)),
      `${id}: a resting outline button's label is ${resting.toFixed(2)} to 1 on the page`,
    ).toBeGreaterThanOrEqual(READABLE);
    expect(
      Number(filled.toFixed(2)),
      `${id}: the same label once the button fills is ${filled.toFixed(2)} to 1 on the accent`,
    ).toBeGreaterThanOrEqual(READABLE);
  });

  it('reads the themes rather than a copy of them', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(11);
    expect(Object.keys(colours('catppuccin-frappe', 'dark'))).toContain('--accent-foreground');
  });
});
