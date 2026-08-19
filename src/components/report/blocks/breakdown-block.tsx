/** The second chart: a single bar split into proportional segments, with a legend below (`blocks.py`'s `_breakdown`). */
import { TONE_HSL } from '../tone';
import type { BreakdownBlock } from '../types';

const W = 640;
const H = 34;

export function BreakdownBlockView({ block }: { block: BreakdownBlock }) {
  const { parts, unit = '', alt } = block;
  const total = parts.reduce((sum, p) => sum + p.value, 0) || 1;
  let x = 0;
  const segments = parts.map((p) => {
    const width = (p.value / total) * W;
    const seg = { x, width: Math.max(width, 1), fill: TONE_HSL[p.tone ?? 'blue'] };
    x += width;
    return seg;
  });

  return (
    <div className="grid grid-cols-1 gap-2.5">
      <svg className="block h-auto w-full" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={alt || 'breakdown'}>
        {segments.map((seg, i) => (
          <rect key={i} x={seg.x} y={0} width={seg.width} height={H} fill={seg.fill} />
        ))}
      </svg>
      <div className="flex flex-wrap gap-3.5 text-xs text-t-muted">
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <b className="block h-2 w-2 rounded-sm" style={{ background: TONE_HSL[p.tone ?? 'blue'] }} />
            {p.label} {p.value}
            {unit}
          </span>
        ))}
      </div>
    </div>
  );
}
