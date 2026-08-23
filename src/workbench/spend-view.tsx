/**
 * What each project cost, per day.
 *
 * Two charts and never one: Claude reports money and Codex reports tokens, and
 * the two are never added together or converted into each other — a token has
 * no price here (decision 12, docs/agent-workbench.md §8.4f).
 */
'use client';

import { useEffect, useState } from 'react';

import { X } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Button } from '@/components/ui/button';
import * as api from '@/lib/api';
import { request } from '@/lib/api';

interface Row {
  day: string;
  projectId: string;
  brand: string;
  usd: number;
  tokens: number;
}

/** One row per day, one column per project — the shape a bar chart wants. */
export function byDay(rows: Row[], field: 'usd' | 'tokens', names: Map<string, string>): Record<string, number | string>[] {
  const days = new Map<string, Record<string, number | string>>();
  for (const r of rows) {
    const amount = r[field];
    if (!amount) continue;
    const day = days.get(r.day) ?? { day: r.day };
    const name = names.get(r.projectId) ?? r.projectId;
    day[name] = Number(day[name] ?? 0) + amount;
    days.set(r.day, day);
  }
  return Array.from(days.values()).sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

/** The project names appearing in one chart's rows, in a stable order. */
export function seriesOf(data: Record<string, number | string>[]): string[] {
  const seen = new Set<string>();
  for (const row of data) for (const k of Object.keys(row)) if (k !== 'day') seen.add(k);
  return Array.from(seen).sort();
}

/**
 * The chart's colours are the theme's, read from it rather than spelled here:
 * a chart with its own palette is the one thing on the screen that ignores the
 * theme the owner picked.
 *
 * `read` is asked for a custom property and answers what the theme currently
 * holds. Fewer colours than series means the palette repeats — the legend, not
 * the colour, is what names a project.
 */
export function paletteFrom(read: (name: string) => string, tokens: number = CHART_TOKENS): string[] {
  const found: string[] = [];
  for (let i = 1; i <= tokens; i++) {
    const value = read(`--chart-${i}`).trim();
    if (value) found.push(value.startsWith('hsl') || value.startsWith('#') ? value : `hsl(${value})`);
  }
  return found;
}

/** How many `--chart-N` the themes define. */
const CHART_TOKENS = 5;

/** The palette as the theme holds it now, and again whenever the theme changes. */
function useChartPalette(): string[] {
  const [palette, setPalette] = useState<string[]>([]);
  useEffect(() => {
    const read = () => {
      const style = getComputedStyle(document.documentElement);
      setPalette(paletteFrom((name) => style.getPropertyValue(name)));
    };
    read();
    // The theme is a data attribute on <html>; switching it repaints the chart.
    const watch = new MutationObserver(read);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => watch.disconnect();
  }, []);
  return palette;
}

function Chart({ title, unit, data, testId }: {
  title: string;
  unit: (v: number) => string;
  data: Record<string, number | string>[];
  testId: string;
}) {
  const series = seriesOf(data);
  const palette = useChartPalette();
  return (
    <div data-testid={testId} data-days={data.length} className="rounded-lg border border-border/60 p-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
      {data.length ? (
        <div style={{ width: '100%', height: 220 }}>
          <ResponsiveContainer>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/60" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={unit} width={70} />
              <Tooltip formatter={(v: number) => unit(v)} />
              <Legend />
              {series.map((name, i) => (
                // Side by side rather than stacked, and drawn at once: a chart
                // that grows into place says nothing a still one does not, and
                // a picture taken of it mid-grow is a picture of nothing.
                <Bar
                  key={name}
                  dataKey={name}
                  fill={palette.length ? palette[i % palette.length] : 'currentColor'}
                  maxBarSize={56}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">Nothing spent this way yet.</p>
      )}
    </div>
  );
}

export function SpendView({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    void request('/api/workbench/spend')
      .then((r) => (r.ok ? r.json() : []))
      .then((got: Row[]) => setRows(got))
      .catch(() => setRows([]));
    void api.projects
      .list()
      .then((ps) => setNames(new Map(ps.map((p) => [p.id, p.name]))))
      .catch(() => undefined);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-8" data-testid="spend-view">
      <div className="w-full max-w-4xl space-y-3 overflow-y-auto rounded-lg border border-border/60 bg-background p-4 shadow-2xl">
        <div className="flex items-center">
          <h2 className="text-base font-semibold text-foreground">What it cost</h2>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            data-testid="spend-close"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        <Chart
          testId="spend-money"
          title="Money, per day, per project"
          // Sub-cent turns are ordinary here, and every tick reading $0.01 is
          // a chart with no scale at all.
          unit={(v) => `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`}
          data={byDay(rows, 'usd', names)}
        />
        <Chart
          testId="spend-tokens"
          title="Tokens, per day, per project"
          unit={(v) => v.toLocaleString()}
          data={byDay(rows, 'tokens', names)}
        />
        <p className="text-[11px] text-muted-foreground">
          Two charts, never one: one brand bills money and the other counts tokens, and neither is
          converted into the other.
        </p>
      </div>
    </div>
  );
}
