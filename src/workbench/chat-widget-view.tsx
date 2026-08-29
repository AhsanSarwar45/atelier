'use client';

import { useEffect, useState } from 'react';

import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronRight, Circle, Clock, FileCode2, Pause, Play } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Progress } from '@/components/ui/progress';
import { apiUrl } from '@/lib/api-base';
import type { ChartWidget, ChatWidget, ExplainerWidget } from '@/workbench/chat-widgets';
import { ImageComparisonView } from '@/workbench/image-comparison';
import { VisualArtifactView } from '@/workbench/visual-artifact-view';
import { openLocalPath } from '@/workbench/open-local-path';

const COLORS = ['var(--color-primary)', 'var(--color-info)', 'var(--color-success)', 'var(--color-warning)'];
const EXPLAINER_ACCENTS = ['var(--color-info-accent)', 'var(--color-warning-accent)', 'var(--color-success-accent)', 'var(--color-primary-accent)', 'var(--color-destructive-accent)'];

function explainerAccent(index: number): string {
  return EXPLAINER_ACCENTS[index % EXPLAINER_ACCENTS.length]!;
}

function Heading({ title }: { title?: string }) {
  return title ? <h4 className="mb-3 text-sm font-semibold text-foreground">{title}</h4> : null;
}

function mediaUrl(src: string): string {
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  try {
    const path = src.startsWith('file://') ? decodeURIComponent(new URL(src).pathname) : src;
    return apiUrl(`/api/fs/media?path=${encodeURIComponent(path)}`);
  } catch {
    return '';
  }
}

const presentationAssetUrl = (asset: string) => apiUrl(`/api/presentation-assets/${encodeURIComponent(asset)}`);

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

function NodeCard({ node, lit, accent, className = '' }: { node: ExplainerWidget['nodes'][number]; lit: boolean; accent: string; className?: string }) {
  return <Panel data-node={node.id} data-active={lit} data-accent={accent} tone="frame"
    style={{
      borderColor: `color-mix(in srgb, ${accent} ${lit ? 85 : 38}%, transparent)`,
      background: lit
        ? `linear-gradient(135deg, color-mix(in srgb, ${accent} 25%, var(--color-surface-base)), color-mix(in srgb, ${accent} 10%, var(--color-surface-base)))`
        : `color-mix(in srgb, ${accent} 7%, var(--color-surface-base))`,
      boxShadow: lit ? `0 0 0 1px color-mix(in srgb, ${accent} 30%, transparent), 0 8px 24px color-mix(in srgb, ${accent} 18%, transparent)` : undefined,
    }}
    className={`relative overflow-hidden p-2.5 transition-all duration-500 motion-reduce:transition-none ${lit ? 'opacity-100' : 'opacity-65'} ${className}`}>
    <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: accent }} />
    <div className="text-xs font-semibold text-foreground">{node.label}</div>
    {node.detail && <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{node.detail}</div>}
  </Panel>;
}

function FlowDiagram({ widget, active, playing }: { widget: ExplainerWidget; active: Set<string>; playing: boolean }) {
  return <div className="grid grid-cols-3 gap-2">
    {widget.nodes.map((node, index) => <NodeCard key={node.id} node={node} lit={active.has(node.id)} accent={explainerAccent(index)} className={active.has(node.id) && playing ? 'animate-pulse motion-reduce:animate-none' : ''} />)}
    <div className="col-span-3 flex flex-wrap gap-1.5 pt-1">
      {widget.edges.map((edge) => { const accent = explainerAccent(Math.max(0, widget.nodes.findIndex((node) => node.id === edge.from))); const lit = active.has(edge.from) || active.has(edge.to); return <span key={`${edge.from}-${edge.to}`} data-accent={accent}
        style={{ borderColor: `color-mix(in srgb, ${accent} ${lit ? 75 : 30}%, transparent)`, background: `color-mix(in srgb, ${accent} ${lit ? 15 : 5}%, transparent)` }}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] transition-all duration-500 motion-reduce:transition-none ${lit ? 'text-foreground' : 'opacity-50'}`}>
        {edge.from}<ChevronRight className="size-3" />{edge.label ?? edge.to}
      </span>; })}
    </div>
  </div>;
}

function SequenceDiagram({ widget, active, playing }: { widget: ExplainerWidget; active: Set<string>; playing: boolean }) {
  const at = (id: string) => Math.max(0, widget.nodes.findIndex((node) => node.id === id));
  return <div className="min-w-[28rem]">
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${widget.nodes.length}, minmax(5rem, 1fr))` }}>
      {widget.nodes.map((node, index) => <div key={node.id} className="text-center"><NodeCard node={node} lit={active.has(node.id)} accent={explainerAccent(index)} /><div className="mx-auto h-5 w-px border-l border-dashed" style={{ borderColor: `color-mix(in srgb, ${explainerAccent(index)} 45%, transparent)` }} /></div>)}
    </div>
    <div className="space-y-2">
      {widget.edges.map((edge) => {
        const from = at(edge.from); const to = at(edge.to); const lit = active.has(edge.from) || active.has(edge.to); const accent = explainerAccent(from);
        return <div key={`${edge.from}-${edge.to}`} className="grid h-7 items-center" style={{ gridTemplateColumns: `repeat(${widget.nodes.length}, minmax(5rem, 1fr))` }}>
          <div data-accent={accent} className="relative border-t-2 transition-all duration-500 motion-reduce:transition-none" style={{ gridColumn: `${Math.min(from, to) + 1} / ${Math.max(from, to) + 2}`, borderColor: `color-mix(in srgb, ${accent} ${lit ? 90 : 28}%, transparent)` }}>
            <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap bg-background px-1 text-[9px] text-muted-foreground">{edge.label ?? `${edge.from} → ${edge.to}`}</span>
            <span className={`absolute -top-1.5 size-3 rounded-full transition-[left] duration-700 motion-reduce:transition-none ${lit && playing ? 'animate-ping motion-reduce:animate-none' : ''}`} style={{ left: lit ? (from <= to ? '100%' : '0%') : (from <= to ? '0%' : '100%'), background: accent, boxShadow: `0 0 12px ${accent}` }} />
          </div>
        </div>;
      })}
    </div>
  </div>;
}

function CycleDiagram({ widget, active, playing }: { widget: ExplainerWidget; active: Set<string>; playing: boolean }) {
  return <div className="relative mx-auto h-64 max-w-md">
    <div className={`absolute left-1/2 top-1/2 size-24 -translate-x-1/2 -translate-y-1/2 rounded-full p-[2px] ${playing ? 'animate-spin motion-reduce:animate-none' : ''}`}
      style={{ background: `conic-gradient(${EXPLAINER_ACCENTS.slice(0, 4).join(', ')}, ${EXPLAINER_ACCENTS[0]})`, opacity: playing ? 1 : .65 }}>
      <div className="size-full rounded-full bg-background" />
    </div>
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Repeat</div>
    {widget.nodes.map((node, index) => {
      const angle = (index / widget.nodes.length) * Math.PI * 2 - Math.PI / 2;
      return <div key={node.id} className="absolute w-28 -translate-x-1/2 -translate-y-1/2" style={{ left: `${50 + Math.cos(angle) * 38}%`, top: `${50 + Math.sin(angle) * 38}%` }}>
        <NodeCard node={node} lit={active.has(node.id)} accent={explainerAccent(index)} className={active.has(node.id) && playing ? 'animate-pulse motion-reduce:animate-none' : ''} />
      </div>;
    })}
  </div>;
}

function LayersDiagram({ widget, active }: { widget: ExplainerWidget; active: Set<string> }) {
  return <div className="mx-auto flex max-w-md flex-col gap-1.5 py-2">
    {widget.nodes.map((node, index) => <NodeCard key={node.id} node={node} lit={active.has(node.id)} accent={explainerAccent(index)} className={`${active.has(node.id) ? 'translate-x-3' : ''}`} />)}
  </div>;
}

function ExplainerDiagram({ widget, active, playing }: { widget: ExplainerWidget; active: Set<string>; playing: boolean }) {
  const layout = widget.layout ?? 'flow';
  if (layout === 'sequence') return <SequenceDiagram widget={widget} active={active} playing={playing} />;
  if (layout === 'cycle') return <CycleDiagram widget={widget} active={active} playing={playing} />;
  if (layout === 'layers') return <LayersDiagram widget={widget} active={active} />;
  return <FlowDiagram widget={widget} active={active} playing={playing} />;
}

function Explainer({ widget }: { widget: ExplainerWidget }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const current = widget.steps[step]!;
  const active = new Set(current.active);

  useEffect(() => {
    if (!playing || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setStep((value) => (value + 1) % widget.steps.length), 1800);
    return () => window.clearInterval(timer);
  }, [playing, widget.steps.length]);

  return (
    <Panel data-testid="chat-widget" data-widget="explainer" tone="frame" className="mb-3 max-w-2xl overflow-hidden">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Heading title={widget.title} />
          {widget.summary && <p className="-mt-1 mb-3 text-xs leading-relaxed text-muted-foreground">{widget.summary}</p>}
        </div>
        {widget.steps.length > 1 && <Button type="button" variant="outline" size="icon" radius="full" aria-label={playing ? 'Pause explanation' : 'Play explanation'} aria-pressed={playing}
          onClick={() => setPlaying((value) => !value)} className="size-8">
          {playing ? <Pause className="size-3.5" /> : <Play className="ml-0.5 size-3.5" />}
        </Button>}
      </div>

      <Panel role="img" data-layout={widget.layout ?? 'flow'} aria-label={`${widget.title ?? 'Concept'} ${widget.layout ?? 'flow'} diagram, step ${step + 1} of ${widget.steps.length}`} tone="frame" className="overflow-x-auto bg-muted/20 p-3">
        <ExplainerDiagram widget={widget} active={active} playing={playing} />
      </Panel>

      <div className="mt-3" aria-live="polite">
        <div className="text-sm font-medium text-foreground">{current.label}</div>
        {current.detail && <p className="mt-0.5 text-xs text-muted-foreground">{current.detail}</p>}
      </div>
      <div className="mt-2 flex gap-1" aria-label="Explanation steps">
        {widget.steps.map((item, index) => <Button key={`${item.label}-${index}`} type="button" variant="ghost" aria-label={`Step ${index + 1}: ${item.label}`} aria-current={index === step ? 'step' : undefined}
          onClick={() => { setStep(index); setPlaying(false); }} style={index === step ? { background: explainerAccent(index) } : undefined}
          className={`h-1.5 flex-1 rounded-full transition-colors motion-reduce:transition-none ${index === step ? '' : 'bg-muted hover:bg-muted-foreground/40'}`} />)}
      </div>
      {widget.evidence && widget.evidence.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
        {widget.evidence.map((item) => <Button type="button" key={`${item.path}:${item.line ?? ''}`} variant="secondary" size="xs" onClick={() => openLocalPath(item.path, 'vscode', item.line)}
          className="text-[11px] text-muted-foreground hover:text-foreground">
          <FileCode2 className="size-3" />{item.label}{item.line ? `:${item.line}` : ''}
        </Button>)}
      </div>}
    </Panel>
  );
}

export function ChatWidgetView({ widget }: { widget: ChatWidget }) {
  if (widget.type === 'artifact') return (
    <Panel data-testid="chat-widget" data-widget="artifact" data-artifact-kind={widget.kind} tone="frame" className="mb-3 max-w-4xl overflow-hidden">
      <Heading title={widget.title} />
      <VisualArtifactView asset={widget.asset} />
    </Panel>
  );
  if (widget.type === 'explainer') return <Explainer widget={widget} />;
  if (widget.type === 'image') return (
    <Panel data-testid="chat-widget" data-widget="image" tone="frame" className="mb-3 max-w-2xl">
      <Heading title={widget.title} />
      <figure>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={presentationAssetUrl(widget.asset)} alt={widget.alt} className="max-h-[38rem] w-full rounded-md object-contain" />
        {widget.caption && <figcaption className="mt-2 text-xs text-muted-foreground">{widget.caption}</figcaption>}
      </figure>
    </Panel>
  );
  if (widget.type === 'image_compare') return (
    <Panel data-testid="chat-widget" data-widget="image_compare" tone="frame" className="mb-3 max-w-2xl">
      <Heading title={widget.title} />
      <ImageComparisonView comparison={{
        mode: widget.mode,
        before: { mime: 'image/*', dataUrl: presentationAssetUrl(widget.before.asset), alt: widget.before.alt },
        after: { mime: 'image/*', dataUrl: presentationAssetUrl(widget.after.asset), alt: widget.after.alt },
      }} />
    </Panel>
  );
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
