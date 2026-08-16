/**
 * The spend charts take their colours from the theme.
 *
 * A chart that carries its own palette is the one thing on the screen that does
 * not change when the owner changes the theme — and the way that regresses is a
 * hex value dropped back in, which this catches without a browser.
 */
import { describe, expect, it } from 'vitest';

import { paletteFrom } from '@/workbench/spend-view';

describe('the chart palette', () => {
  it('reads the theme tokens and hands back colours a chart can draw', () => {
    const theme: Record<string, string> = {
      '--chart-1': ' 220 70% 50% ',
      '--chart-2': '160 60% 45%',
      '--chart-3': '30 80% 55%',
      '--chart-4': '280 65% 60%',
      '--chart-5': '340 75% 55%',
    };
    expect(paletteFrom((n) => theme[n] ?? '')).toEqual([
      'hsl(220 70% 50%)',
      'hsl(160 60% 45%)',
      'hsl(30 80% 55%)',
      'hsl(280 65% 60%)',
      'hsl(340 75% 55%)',
    ]);
  });

  it('takes a theme at its word when it already spells a colour', () => {
    expect(paletteFrom((n) => (n === '--chart-1' ? '#34d399' : ''), 2)).toEqual(['#34d399']);
  });

  it('hands back nothing when the theme defines nothing, rather than a colour of its own', () => {
    expect(paletteFrom(() => '')).toEqual([]);
  });
});
