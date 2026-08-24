"use client";

import { useMemo, useState } from "react";

import { Panel } from "@/components/ui/panel";
import { colorFor } from "@/lib/state-styles";
import { STATES, type BeadCounts } from "@/types";

interface StatusDonutProps {
  beadCounts: BeadCounts;
  size?: number;
  className?: string;
  /**
   * When `false`, renders a dashed/outline placeholder donut regardless
   * of the numeric counts. Used on the home page to signal "counts are
   * still loading from the backend, no cached value yet" without
   * showing a misleading "0 tasks" state.
   */
  countsLoaded?: boolean;
}



// Custom tooltip showing all statuses
function StatusTooltip({ beadCounts, total }: { beadCounts: BeadCounts; total: number }) {
  return (
    <Panel tone="overlay" inset="sm">
      <div className="mb-1.5 text-xs font-medium text-t-secondary">
        {total} task{total !== 1 ? "s" : ""}
      </div>
      <div className="space-y-1">
        {STATES.filter((s) => beadCounts[s.id] > 0).map((s) => (
          <div key={s.id} className="flex items-center gap-2 text-xs">
            <div className="h-2 w-2 rounded-sm" style={{ backgroundColor: colorFor(s.id) }} />
            <span className="text-t-tertiary">{s.label}</span>
            <span className="ml-auto font-mono text-t-primary">{beadCounts[s.id]}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function StatusDonut({ beadCounts, size = 40, className, countsLoaded = true }: StatusDonutProps) {
  const [isHovered, setIsHovered] = useState(false);

  const chartData = useMemo(() => {
    return STATES
      .map((s) => ({ status: s.id, count: beadCounts[s.id] ?? 0, fill: colorFor(s.id) }))
      .filter((item) => item.count > 0);
  }, [beadCounts]);

  const total = useMemo(() => {
    return STATES.reduce((n, s) => n + (beadCounts[s.id] ?? 0), 0);
  }, [beadCounts]);

  // Dashed placeholder when counts haven't loaded yet, OR when the
  // project genuinely has no tasks. Same visual — the former resolves
  // to a solid donut on its own once `countsLoaded` flips to true, the
  // latter stays dashed indefinitely which is correct semantics.
  if (!countsLoaded || total === 0) {
    const label = !countsLoaded ? "Loading tasks" : "No tasks";
    return (
      <div
        className={className}
        style={{ width: size, height: size }}
        aria-label={label}
        aria-busy={!countsLoaded}
      >
        <div
          className="rounded-full border-2 border-dashed border-b-strong w-full h-full"
          title={label}
        />
      </div>
    );
  }

  const innerRadius = size * 0.32;
  const outerRadius = size * 0.48;
  // Only add padding when there are multiple segments
  const paddingAngle = chartData.length > 1 ? 3 : 0;

  return (
    <div
      className={`relative ${className || ""}`}
      style={{ width: size, height: size }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`translate(${size / 2}, ${size / 2})`}>
          {/* Render pie segments */}
          {chartData.map((entry, index) => {
            // Calculate angles for each segment
            const startAngle = chartData
              .slice(0, index)
              .reduce((acc, d) => acc + (d.count / total) * 360, 0);
            const segmentAngle = (entry.count / total) * 360;
            const endAngle = startAngle + segmentAngle;

            // Check if this is a full circle (single segment covering 100%)
            const isFullCircle = chartData.length === 1;

            if (isFullCircle) {
              // For full circle, use two semicircular arcs
              // This avoids the issue where start and end points are the same
              return (
                <g key={entry.status}>
                  {/* First semicircle (top half) */}
                  <path
                    d={`M 0 ${-outerRadius} A ${outerRadius} ${outerRadius} 0 0 1 0 ${outerRadius} L 0 ${innerRadius} A ${innerRadius} ${innerRadius} 0 0 0 0 ${-innerRadius} Z`}
                    fill={entry.fill}
                  />
                  {/* Second semicircle (bottom half) */}
                  <path
                    d={`M 0 ${outerRadius} A ${outerRadius} ${outerRadius} 0 0 1 0 ${-outerRadius} L 0 ${-innerRadius} A ${innerRadius} ${innerRadius} 0 0 0 0 ${innerRadius} Z`}
                    fill={entry.fill}
                  />
                </g>
              );
            }

            // Add small padding between segments (only if multiple segments)
            const adjustedStart = startAngle + paddingAngle / 2;
            const adjustedEnd = endAngle - paddingAngle / 2;

            // Convert to radians (SVG uses radians, start from top)
            const startRad = ((adjustedStart - 90) * Math.PI) / 180;
            const endRad = ((adjustedEnd - 90) * Math.PI) / 180;

            // Calculate arc path
            const x1 = Math.cos(startRad) * outerRadius;
            const y1 = Math.sin(startRad) * outerRadius;
            const x2 = Math.cos(endRad) * outerRadius;
            const y2 = Math.sin(endRad) * outerRadius;
            const x3 = Math.cos(endRad) * innerRadius;
            const y3 = Math.sin(endRad) * innerRadius;
            const x4 = Math.cos(startRad) * innerRadius;
            const y4 = Math.sin(startRad) * innerRadius;

            const largeArcFlag = adjustedEnd - adjustedStart > 180 ? 1 : 0;

            const d = [
              `M ${x1} ${y1}`,
              `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${x2} ${y2}`,
              `L ${x3} ${y3}`,
              `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${x4} ${y4}`,
              "Z",
            ].join(" ");

            return (
              <path
                key={entry.status}
                d={d}
                fill={entry.fill}
              />
            );
          })}
          {/* Invisible circle covering entire donut area for hover detection */}
          <circle
            r={outerRadius}
            fill="transparent"
            style={{ cursor: "default" }}
          />
        </g>
      </svg>

      {/* Tooltip - shown on hover anywhere in the donut area */}
      {isHovered && (
        <div className="absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap">
          <StatusTooltip beadCounts={beadCounts} total={total} />
        </div>
      )}
    </div>
  );
}
