/** The third chart: one or more lines over a shared x-axis, four gridlines, a legend (`blocks.py`'s `_trend`). */
import { TONE_HSL } from '../tone';
import type { TrendBlock } from '../types';

const W = 640;
const H = 240;
const L = 54;
const R = 14;
const T = 12;
const BOT = 34;

/** Python's `%.4g` — four significant figures, trailing zeros trimmed. Axis labels only need to be short, not exact. */
function g4(v: number): string {
  if (v === 0) return '0';
  const s = v.toPrecision(4);
  if (s.includes('e') || s.includes('E')) return s;
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function TrendBlockView({ block }: { block: TrendBlock }) {
  const { x: xs, lines, unit = '', alt } = block;
  const values = lines.flatMap((ln) => ln.values);
  const lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) hi = lo + 1;
  const span = hi - lo;

  const px = (i: number) => L + (W - L - R) * (i / Math.max(xs.length - 1, 1));
  const py = (v: number) => T + (H - T - BOT) * (1 - (v - lo) / span);

  const gridlines = [0, 1, 2, 3].map((k) => {
    const y = T + ((H - T - BOT) * k) / 3;
    const val = hi - (span * k) / 3;
    return { y, val };
  });

  return (
    <div className="grid grid-cols-1 gap-2.5">
      <svg className="block h-auto w-full" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={alt || 'trend'}>
        {gridlines.map((g, i) => (
          <g key={i}>
            <line x1={L} y1={g.y} x2={W - R} y2={g.y} stroke="hsl(var(--border-subtle))" strokeWidth={1} />
            <text x={L - 8} y={g.y + 4} textAnchor="end" fontSize={11} fill="hsl(var(--text-muted))">
              {g4(g.val)}
              {unit}
            </text>
          </g>
        ))}
        {xs.map((label, i) => (
          // The first and last labels lean in rather than centring on their
          // point: centred, half of each hangs outside the chart's box, and an
          // SVG clips whatever leaves it — the two labels that say where the
          // line starts and ends were the two being cut (bw-7ks.21.10).
          <text
            key={i}
            x={px(i)}
            y={H - 10}
            textAnchor={i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle'}
            fontSize={11}
            fill="hsl(var(--text-muted))"
          >
            {label}
          </text>
        ))}
        {lines.map((ln, i) => {
          const stroke = TONE_HSL[ln.tone ?? 'blue'];
          const pts = ln.values.map((v, j) => `${px(j)},${py(v)}`).join(' ');
          const last = ln.values.length - 1;
          return (
            <g key={i}>
              <polyline fill="none" stroke={stroke} strokeWidth={2.5} points={pts} />
              <circle cx={px(last)} cy={py(ln.values[last])} r={4} fill={stroke} />
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-3.5 text-xs text-t-muted">
        {lines.map((ln, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <b className="block h-2 w-2 rounded-sm" style={{ background: TONE_HSL[ln.tone ?? 'blue'] }} />
            {ln.label}
          </span>
        ))}
      </div>
    </div>
  );
}
