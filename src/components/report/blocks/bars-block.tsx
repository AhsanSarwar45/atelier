/**
 * The horizontal bar chart, one of the three real charts (no image, no chart
 * library). Geometry follows `blocks.py`'s `_bars`: a fixed 640-unit viewBox
 * so the SVG scales losslessly with the reading column, one row per series
 * item, bar length proportional to its share of the largest absolute value.
 * Colour comes from `TONE_HSL`, which the class-based tone tables (`tone.ts`)
 * cannot reach — `fill`/`stroke` are SVG presentation attributes, not
 * classes Tailwind can see.
 */
import { TONE_HSL } from '../tone';
import type { BarsBlock } from '../types';

const ROW_H = 34;
const PAD = 6;
const LAB_W = 150;
const VAL_W = 78;
const W = 640;
const BAR_W = W - LAB_W - VAL_W;

export function BarsBlockView({ block }: { block: BarsBlock }) {
  const { series, unit = '', alt } = block;
  const peak = Math.max(...series.map((s) => Math.abs(s.value)), 1e-9);
  const h = series.length * ROW_H;

  return (
    <svg
      className="block h-auto w-full"
      viewBox={`0 0 ${W} ${h}`}
      role="img"
      aria-label={alt || 'bar comparison'}
    >
      {series.map((s, i) => {
        const y = i * ROW_H;
        const length = Math.max(2, (Math.abs(s.value) / peak) * BAR_W);
        const fill = TONE_HSL[s.tone ?? 'blue'];
        return (
          <g key={i}>
            <text
              x={LAB_W - 10}
              y={y + ROW_H / 2 + 4}
              textAnchor="end"
              fontSize={11}
              fill="hsl(var(--text-muted))"
            >
              {s.label}
            </text>
            <rect x={LAB_W} y={y + PAD} width={length} height={ROW_H - 2 * PAD} rx={2} fill={fill} />
            <text
              x={LAB_W + length + 8}
              y={y + ROW_H / 2 + 4}
              fontSize={11}
              fontWeight={700}
              fontFamily="var(--font-mono)"
              fill="hsl(var(--text-secondary))"
            >
              {s.value}
              {unit}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
