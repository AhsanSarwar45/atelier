/**
 * The horizontal bar chart, drawn in the page's own boxes rather than in an
 * SVG of fixed width.
 *
 * It used to be a 640-unit viewBox with the labels and the numbers drawn as
 * SVG text, the way `blocks.py` draws them for the standalone page. Inside a
 * reading column that changes width, that geometry has no give: a label longer
 * than its 150 units ran off the left edge and a bar near full length pushed
 * its number off the right, and an SVG clips whatever leaves its box — so the
 * chart quietly lost the very words and figures it exists to show. Rows of
 * boxes have give: the label wraps, the bar takes what is left, and the number
 * always has room (bw-7ks.21.10).
 *
 * Colour still comes from `TONE_HSL`, which the class-based tone tables
 * (`tone.ts`) cannot reach for an inline background.
 */
import { Fragment } from 'react';

import { TONE_HSL } from '../tone';
import type { BarsBlock } from '../types';

export function BarsBlockView({ block }: { block: BarsBlock }) {
  const { series, unit = '', alt } = block;
  const peak = Math.max(...series.map((s) => Math.abs(s.value)), 1e-9);

  return (
    <div
      role="img"
      aria-label={alt || 'bar comparison'}
      className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto]"
    >
      {series.map((s, i) => (
        <Fragment key={i}>
          <span className="min-w-0 text-right text-xs leading-tight text-t-muted [overflow-wrap:anywhere]">
            {s.label}
          </span>
          <span className="h-5 min-w-0 rounded-sm bg-surface-overlay">
            <span
              data-bar
              className="block h-5 rounded-sm"
              style={{
                width: `${(Math.abs(s.value) / peak) * 100}%`,
                minWidth: 2,
                background: TONE_HSL[s.tone ?? 'blue'],
              }}
            />
          </span>
          <span className="whitespace-nowrap text-right font-mono text-xs font-bold tabular-nums text-t-secondary">
            {s.value}
            {unit}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
