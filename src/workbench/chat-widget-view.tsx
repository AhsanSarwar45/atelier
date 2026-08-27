'use client';

import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, Circle, Clock } from 'lucide-react';

import { Panel } from '@/components/ui/panel';
import { Progress } from '@/components/ui/progress';
import { apiUrl } from '@/lib/api-base';
import type { ChartWidget, ChatWidget } from '@/workbench/chat-widgets';

const COLORS = ['var(--color-primary)', 'var(--color-info)', 'var(--color-success)', 'var(--color-warning)'];

function Heading({ title }: { title?: string }) {
  return title ? <h4 className="mb-3 text-sm font-semibold text-foreground">{title}</h4> : null;
}

function mediaUrl(src: string): string {
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  const path = src.startsWith('file://') ? decodeURIComponent(new URL(src).pathname) : src;
  return apiUrl(`/api/fs/media?path=${encodeURIComponent(path)}`);
}

function Chart({ widget }: { widget: ChartWidget }) {
  const values = widget.data.flatMap((point) => point.values);
  const high = Math.max(...values, 0);
  const low = Math.min(...values, 0);
  const range = high - low || 1;
  const x = (index: number) => widget.data.length === 1 ? 150 : 16 + index * (268 / (widget.data.length - 1));
  const y = (value: number) => 12 + ((high - value) / range) * 116;
  return (
    <div>
      <svg viewBox="0 0 300 160" role="img" aria-label={`${widget.chart} chart`} className="h-auto max-h-64 w-full overflow-visible">
        <line x1="16" y1="128" x2="284" y2="128" stroke="currentColor" opacity=".2" />
        {widget.chart === 'line' ? widget.series.map((series, seriesIndex) => (
          <polyline key={series.name} fill="none" stroke={series.color || COLORS[seriesIndex]} strokeWidth="3" strokeLinejoin="round"
            points={widget.data.map((point, index) => `${x(index)},${y(point.values[seriesIndex]!)}`).join(' ')} />
        )) : widget.data.flatMap((point, pointIndex) => point.values.map((value, seriesIndex) => {
          const group = 230 / widget.data.length;
          const width = Math.max(4, group / widget.series.length - 3);
          const left = 20 + pointIndex * (264 / widget.data.length) + seriesIndex * (width + 3);
          return <rect key={`${point.label}-${seriesIndex}`} x={left} y={y(value)} width={width} height={128 - y(value)} rx="2" fill={widget.series[seriesIndex]?.color || COLORS[seriesIndex]} />;
        }))}
        {widget.data.map((point, index) => <text key={point.label} x={x(index)} y="150" textAnchor="middle" fontSize="9" fill="currentColor" opacity=".7">{point.label}</text>)}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {widget.series.map((series, index) => <span key={series.name} className="inline-flex items-center gap-1.5"><i className="size-2 rounded-full" style={{ background: series.color || COLORS[index] }} />{series.name}</span>)}
      </div>
    </div>
  );
}

export function ChatWidgetView({ widget }: { widget: ChatWidget }) {
  if (widget.type === 'video') return (
    <Panel data-testid="chat-widget" data-widget="video" tone="frame" className="mb-3 max-w-2xl">
      <Heading title={widget.title} />
      <video className="w-full rounded-md bg-black" controls preload="metadata" src={mediaUrl(widget.src)} poster={widget.poster ? mediaUrl(widget.poster) : undefined}>
        Your browser cannot play this video.
      </video>
    </Panel>
  );
  if (widget.type === 'metrics') return (
    <div data-testid="chat-widget" data-widget="metrics" className="mb-3 max-w-2xl">
      <Heading title={widget.title} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{widget.items.map((item) => {
        const Icon = item.trend === 'up' ? ArrowUpRight : item.trend === 'down' ? ArrowDownRight : ArrowRight;
        return <Panel key={item.label} className="min-w-0"><div className="text-xs text-muted-foreground">{item.label}</div><div className="mt-1 flex items-center gap-1 text-xl font-semibold text-foreground">{item.value}{item.trend && <Icon className="size-4" />}</div>{item.detail && <div className="mt-1 text-xs text-muted-foreground">{item.detail}</div>}</Panel>;
      })}</div>
    </div>
  );
  if (widget.type === 'chart') return <Panel data-testid="chat-widget" data-widget="chart" tone="frame" className="mb-3 max-w-2xl"><Heading title={widget.title} /><Chart widget={widget} /></Panel>;
  if (widget.type === 'progress') return (
    <Panel data-testid="chat-widget" data-widget="progress" className="mb-3 max-w-2xl"><Heading title={widget.title} /><div className="space-y-3">{widget.items.map((item) => { const max = item.max ?? 100; const pct = Math.max(0, Math.min(100, item.value / max * 100)); return <div key={item.label}><div className="mb-1 flex justify-between gap-4 text-xs"><span>{item.label}</span><span className="text-muted-foreground">{item.detail ?? `${item.value}/${max}`}</span></div><Progress value={pct} aria-label={item.label} aria-valuenow={Math.round(pct)} /></div>; })}</div></Panel>
  );
  if (widget.type === 'timeline') return (
    <Panel data-testid="chat-widget" data-widget="timeline" className="mb-3 max-w-2xl"><Heading title={widget.title} /><ol className="space-y-3">{widget.items.map((item) => { const Icon = item.status === 'done' ? Check : item.status === 'current' ? Clock : Circle; return <li key={item.label} className="flex gap-2"><Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><div className="text-sm font-medium">{item.label}</div>{item.detail && <div className="text-xs text-muted-foreground">{item.detail}</div>}</div></li>; })}</ol></Panel>
  );
  return (
    <Panel data-testid="chat-widget" data-widget="table" tone="frame" inset="none" className="mb-3 max-w-2xl overflow-x-auto"><Heading title={widget.title} /><table className="w-full text-left text-xs"><thead className="border-b bg-muted/40"><tr>{widget.columns.map((column) => <th key={column} className="px-3 py-2 font-medium">{column}</th>)}</tr></thead><tbody>{widget.rows.map((row, index) => <tr key={index} className="border-b last:border-0">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 text-muted-foreground">{cell}</td>)}</tr>)}</tbody></table></Panel>
  );
}
