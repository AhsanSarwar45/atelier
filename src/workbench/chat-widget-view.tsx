'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState, type ReactNode } from 'react';

import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, Circle, Clock, FileCode2, Pause, Play, ZoomIn } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTriggerRow } from '@/components/ui/collapsible';
import { Panel } from '@/components/ui/panel';
import { Progress } from '@/components/ui/progress';
import { Tooltip } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { apiUrl } from '@/lib/api-base';
import { cn } from '@/lib/utils';
import type { ChartWidget, ChatWidget, ExplainerWidget } from '@/workbench/chat-widgets';
import { ImageComparisonView } from '@/workbench/image-comparison';
import { PictureViewer } from '@/workbench/picture-viewer';
import type { LookableImage } from '@/workbench/protocol';
import { StoredImage } from '@/workbench/stored-image';
// Diagrams bring mermaid, ELK, React Flow and motion — megabytes a chat with
// no diagram in it never needs, fetched when one is drawn (bw-fbzd.4).
const VisualArtifactView = dynamic(() => import('@/workbench/visual-artifact-view').then((m) => m.VisualArtifactView), { ssr: false });
import { useOpenPath } from '@/workbench/open-path';
import { presentationAssetUrl } from '@/workbench/attachment-store';

const COLORS = ['var(--color-primary-accent)', 'var(--color-info-accent)', 'var(--color-success-accent)', 'var(--color-warning-accent)'];
const EXPLAINER_ACCENTS = ['var(--color-info-accent)', 'var(--color-warning-accent)', 'var(--color-success-accent)', 'var(--color-primary-accent)', 'var(--color-destructive-accent)'];

function explainerAccent(index: number): string {
  return EXPLAINER_ACCENTS[index % EXPLAINER_ACCENTS.length]!;
}

function Heading({ title }: { title?: string }) {
  return title ? <h4 className="mb-3 text-sm font-semibold text-foreground">{title}</h4> : null;
}

function WidgetFrame({ kind, title, children, wide = false, className, artifactKind }: {
  kind: ChatWidget['type'];
  title?: string;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  artifactKind?: string;
}) {
  return (
    <Panel
      data-testid="chat-widget"
      data-widget={kind}
      data-artifact-kind={artifactKind}
      tone="frame"
      inset="md"
      className={cn('my-4', wide ? 'max-w-4xl' : 'max-w-2xl', className)}
    >
      <Heading title={title} />
      {children}
    </Panel>
  );
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



function Chart({ widget }: { widget: ChartWidget }) {
  const values = widget.data.flatMap((point) => point.values);
  const high = Math.max(...values, 0);
  const low = Math.min(...values, 0);
  // Normalize before subtracting: finite input can still overflow high - low.
  const magnitude = Math.max(Math.abs(high), Math.abs(low)) || 1;
  const upper = high / magnitude;
  const lower = low / magnitude;
  const range = upper - lower || 1;
  const width = Math.max(600, widget.data.length * 100);
  const plot = width - 100;
  const group = plot / widget.data.length;
  const x = (index: number) => 70 + group * (index + 0.5);
  const y = (value: number) => 24 + ((upper - value / magnitude) / range) * 180;
  const zero = y(0);
  const ticks = [...new Set([low, 0, high])];
  const format = (value: number) => new Intl.NumberFormat('en', { maximumSignificantDigits: 4, notation: Math.abs(value) >= 1e9 || (value !== 0 && Math.abs(value) < .001) ? 'scientific' : 'standard' }).format(value);
  return <div>
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} 260`} role="img" aria-label={`${widget.chart} chart`} style={{ minWidth: width }} className="h-auto w-full">
        <title>{widget.title ?? `${widget.chart} chart`}</title>
        {ticks.map((value) => <g key={value}>
          <line x1="70" y1={y(value)} x2={width - 30} y2={y(value)} stroke="currentColor" opacity={value === 0 ? .5 : .15} />
          <text x="62" y={y(value) + 4} textAnchor="end" fontSize="11" fill="currentColor">{format(value)}</text>
        </g>)}
        {widget.chart === 'line' ? widget.series.map((series, seriesIndex) => <g key={series.name}>
          <polyline fill="none" stroke={series.color || COLORS[seriesIndex]} strokeWidth="3" strokeLinejoin="round"
            strokeDasharray={['', '8 4', '2 4', '8 3 2 3'][seriesIndex]}
            points={widget.data.map((point, index) => `${x(index)},${y(point.values[seriesIndex]!)}`).join(' ')} />
          {widget.data.map((point, index) => <circle key={index} cx={x(index)} cy={y(point.values[seriesIndex]!)} r="4" fill={series.color || COLORS[seriesIndex]}>
            <title>{`${point.label}: ${series.name} ${point.values[seriesIndex]}`}</title>
          </circle>)}
        </g>) : widget.data.flatMap((point, pointIndex) => point.values.map((value, seriesIndex) => {
          const barWidth = group * .7 / widget.series.length;
          return <rect key={`${pointIndex}-${seriesIndex}`} data-value={value}
            x={x(pointIndex) - group * .35 + seriesIndex * barWidth} y={Math.min(y(value), zero)}
            width={barWidth - 2} height={Math.abs(y(value) - zero)} rx="2" fill={widget.series[seriesIndex]?.color || COLORS[seriesIndex]}>
            <title>{`${point.label}: ${widget.series[seriesIndex]!.name} ${value}`}</title>
          </rect>;
        }))}
        {widget.data.map((point, index) => <text key={index} x={x(index)} y="230" textAnchor="middle" fontSize="11" fill="currentColor">
          <title>{point.label}</title>{point.label.length > 13 ? `${point.label.slice(0, 12)}…` : point.label}
        </text>)}
      </svg>
    </div>
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {widget.series.map((series, index) => <span key={series.name} className="inline-flex items-center gap-1.5"><i className="size-2 rounded-full" style={{ background: series.color || COLORS[index] }} />{series.name}</span>)}
    </div>
    <Collapsible className="mt-3 text-xs">
      <CollapsibleTriggerRow size="sm">View data</CollapsibleTriggerRow>
      <CollapsibleContent>
      <div className="mt-2 overflow-x-auto"><table className="w-full text-left">
        <caption className="sr-only">{widget.title ?? 'Chart data'}</caption>
        <thead><tr><th scope="col" className="p-2">Category</th>{widget.series.map((series) => <th scope="col" className="p-2" key={series.name}>{series.name}</th>)}</tr></thead>
        <tbody>{widget.data.map((point, index) => <tr key={index}><th scope="row" className="p-2 font-normal">{point.label}</th>{point.values.map((value, i) => <td className="p-2 tabular-nums" key={i}>{value}</td>)}</tr>)}</tbody>
      </table></div>
      </CollapsibleContent>
    </Collapsible>
  </div>;
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

function Relationships({ widget, active }: { widget: ExplainerWidget; active: Set<string> }) {
  const name = (id: string) => widget.nodes.find((node) => node.id === id)!.label;
  return <ol aria-label="Relationships" className="mt-3 space-y-2 text-xs">
    {widget.edges.map((edge, index) => <Panel asChild key={index} tone="frame" inset="sm" className="flex flex-wrap items-center gap-2"
      style={{ background: active.has(edge.from) && active.has(edge.to) ? 'var(--color-surface-base)' : undefined }}><li data-relationship>
      <span className="font-medium">{name(edge.from)}</span><ArrowRight aria-hidden className="size-3 shrink-0" />
      <span className="font-medium">{name(edge.to)}</span>
      {edge.label && <span className="text-muted-foreground">{edge.label}</span>}
    </li></Panel>)}
  </ol>;
}

function FlowDiagram({ widget, active }: { widget: ExplainerWidget; active: Set<string>; playing: boolean }) {
  return <div>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {widget.nodes.map((node, index) => <NodeCard key={node.id} node={node} lit={active.has(node.id)} accent={explainerAccent(index)} />)}
    </div>
    <Relationships widget={widget} active={active} />
  </div>;
}

function SequenceDiagram({ widget, active }: { widget: ExplainerWidget; active: Set<string>; playing: boolean }) {
  const at = (id: string) => Math.max(0, widget.nodes.findIndex((node) => node.id === id));
  return <div className="min-w-[28rem]">
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${widget.nodes.length}, minmax(10rem, 1fr))` }}>
      {widget.nodes.map((node, index) => <div key={node.id} className="text-center"><NodeCard node={node} lit={active.has(node.id)} accent={explainerAccent(index)} /><div className="mx-auto h-5 w-px border-l border-dashed" style={{ borderColor: `color-mix(in srgb, ${explainerAccent(index)} 45%, transparent)` }} /></div>)}
    </div>
    <div className="space-y-2">
      {widget.edges.map((edge) => {
        const from = at(edge.from); const to = at(edge.to); const lit = active.has(edge.from) || active.has(edge.to); const accent = explainerAccent(from);
        return <div key={`${edge.from}-${edge.to}`} className="grid min-h-10 items-end" style={{ gridTemplateColumns: `repeat(${widget.nodes.length}, minmax(10rem, 1fr))` }}>
          <div data-accent={accent} className="relative border-b-2 pb-1 transition-colors duration-500 motion-reduce:transition-none" style={{ gridColumn: `${Math.min(from, to) + 1} / ${Math.max(from, to) + 2}`, borderColor: `color-mix(in srgb, ${accent} ${lit ? 90 : 28}%, transparent)` }}>
            <span className="block whitespace-normal px-2 text-center text-xs text-muted-foreground">{edge.label ?? `${widget.nodes[from]!.label} → ${widget.nodes[to]!.label}`}</span>
            <ArrowRight aria-hidden className={`absolute -bottom-2 size-4 ${from <= to ? '-right-1' : '-left-1 rotate-180'}`} style={{ color: accent }} />
          </div>
        </div>;
      })}
    </div>
  </div>;
}

function CycleDiagram({ widget, active }: { widget: ExplainerWidget; active: Set<string>; playing: boolean }) {
  // Dense cycles use cards instead of overlapping fixed-position labels.
  return <div>
    {widget.nodes.length <= 4 && widget.nodes.every((node) => node.label.length <= 40 && (node.detail?.length ?? 0) <= 80) ? <div className="relative mx-auto h-72 min-w-[22rem] max-w-md">
      {widget.nodes.map((node, index) => {
        const angle = (index / widget.nodes.length) * Math.PI * 2 - Math.PI / 2;
        return <div key={node.id} className="absolute w-28 -translate-x-1/2 -translate-y-1/2" style={{ left: `${50 + Math.cos(angle) * 32}%`, top: `${50 + Math.sin(angle) * 32}%` }}>
          <NodeCard node={node} lit={active.has(node.id)} accent={explainerAccent(index)} />
        </div>;
      })}
    </div> : <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {widget.nodes.map((node, index) => <NodeCard key={node.id} node={node} lit={active.has(node.id)} accent={explainerAccent(index)} />)}
    </div>}
    <Relationships widget={widget} active={active} />
  </div>;
}

function LayersDiagram({ widget, active }: { widget: ExplainerWidget; active: Set<string> }) {
  return <div className="mx-auto flex max-w-md flex-col gap-1.5 py-2">
    {widget.nodes.map((node, index) => <NodeCard key={node.id} node={node} lit={active.has(node.id)} accent={explainerAccent(index)} />)}
    <Relationships widget={widget} active={active} />
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
  // Evidence opens the way every file in the app opens (bw-lolf.2).
  const openPath = useOpenPath();
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const current = widget.steps[step]!;
  const active = new Set(current.active);

  useEffect(() => {
    if (!playing || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setTimeout(() => {
      if (step === widget.steps.length - 1) setPlaying(false);
      else setStep(step + 1);
    }, 3500);
    return () => window.clearTimeout(timer);
  }, [playing, step, widget.steps.length]);

  return (
    <WidgetFrame kind="explainer" title={widget.title} className="overflow-hidden">
      <div className="flex items-start justify-between gap-3">
        <div>
          {widget.summary && <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{widget.summary}</p>}
        </div>
        {widget.steps.length > 1 && <Button type="button" variant="outline" size="icon" radius="full" aria-label={playing ? 'Pause explanation' : 'Play explanation'} aria-pressed={playing}
          onClick={() => { if (!playing && step === widget.steps.length - 1) setStep(0); setPlaying((value) => !value); }} className="size-8">
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
        {widget.steps.map((item, index) => <Button key={`${item.label}-${index}`} type="button" variant="ghost" size="none" radius="full" aria-label={`Step ${index + 1}: ${item.label}`} aria-current={index === step ? 'step' : undefined}
          onClick={() => { setStep(index); setPlaying(false); }} style={index === step ? { background: explainerAccent(index) } : undefined}
          className={`h-1.5 flex-1 transition-colors motion-reduce:transition-none ${index === step ? '' : 'bg-muted hover:bg-muted-foreground/40'}`} />)}
      </div>
      {widget.evidence && widget.evidence.length > 0 && <><Separator className="mt-3" /><div className="flex flex-wrap gap-1.5 pt-3">
        {widget.evidence.map((item) => <Button type="button" key={`${item.path}:${item.line ?? ''}`} variant="secondary" size="xs" onClick={() => openPath({ absolute: item.path, line: item.line ?? null, endLine: null }, 'files')}
          className="text-muted-foreground hover:text-foreground">
          <FileCode2 />{item.label}{item.line ? `:${item.line}` : ''}
        </Button>)}
      </div></>}
    </WidgetFrame>
  );
}

export function ChatWidgetView({ widget }: { widget: ChatWidget }) {
  const [looking, setLooking] = useState<LookableImage | null>(null);
  // A picture a cleanup rule removed has nothing to open full size.
  const [gone, setGone] = useState(false);
  if (widget.type === 'artifact') return (
    <WidgetFrame kind="artifact" artifactKind={widget.kind} title={widget.title} wide className="overflow-hidden">
      <VisualArtifactView asset={widget.asset} />
    </WidgetFrame>
  );
  if (widget.type === 'explainer') return <Explainer widget={widget} />;
  if (widget.type === 'image') return (
    <WidgetFrame kind="image" title={widget.title}>
      <figure>
        {gone ? (
          <StoredImage src={presentationAssetUrl(widget.asset)} alt={widget.alt} className="w-full" />
        ) : (
        <Tooltip label="Open full size">
        <Button type="button" variant="foreground" aria-label={`Open ${widget.alt} to zoom`}
          size="none" className="group relative block w-full whitespace-normal" onClick={() => setLooking({ mime: 'image/*', dataUrl: presentationAssetUrl(widget.asset), alt: widget.alt })}>
          <StoredImage src={presentationAssetUrl(widget.asset)} alt={widget.alt} onError={() => setGone(true)} className="max-h-[38rem] w-full cursor-zoom-in rounded-md object-contain transition-opacity group-hover:opacity-90" />
          <span aria-hidden className="absolute right-2 top-2 rounded-full bg-background/90 p-2 shadow"><ZoomIn className="size-4" /></span>
        </Button>
        </Tooltip>
        )}
        {widget.caption && <figcaption className="mt-2 text-xs text-muted-foreground">{widget.caption}</figcaption>}
      </figure>
      {looking && <PictureViewer image={looking} onClose={() => setLooking(null)} />}
    </WidgetFrame>
  );
  if (widget.type === 'image_compare') {
    const comparison = {
      mode: widget.mode,
      before: { mime: 'image/*', dataUrl: presentationAssetUrl(widget.before.asset), alt: widget.before.alt },
      after: { mime: 'image/*', dataUrl: presentationAssetUrl(widget.after.asset), alt: widget.after.alt },
    } as const;
    return <WidgetFrame kind="image_compare" title={widget.title}>
      <ImageComparisonView comparison={comparison} onLook={setLooking} />
      {looking && <PictureViewer image={looking} onClose={() => setLooking(null)} />}
    </WidgetFrame>;
  }
  if (widget.type === 'video') return (
    <WidgetFrame kind="video" title={widget.title}>
      <video className="w-full rounded-md bg-black" controls preload="metadata" src={mediaUrl(widget.src)} poster={widget.poster ? mediaUrl(widget.poster) : undefined}>
        Your browser cannot play this video.
      </video>
    </WidgetFrame>
  );
  if (widget.type === 'metrics') return (
    <WidgetFrame kind="metrics" title={widget.title}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{widget.items.map((item) => {
        const Icon = item.trend === 'up' ? ArrowUpRight : item.trend === 'down' ? ArrowDownRight : ArrowRight;
        return <Panel key={item.label} className="min-w-0"><div className="text-xs text-muted-foreground">{item.label}</div><div className="mt-1 flex items-center gap-1 text-xl font-semibold text-foreground">{item.value}{item.trend && <Icon className="size-4" />}</div>{item.detail && <div className="mt-1 text-xs text-muted-foreground">{item.detail}</div>}</Panel>;
      })}</div>
    </WidgetFrame>
  );
  if (widget.type === 'chart') return <WidgetFrame kind="chart" title={widget.title}><Chart widget={widget} /></WidgetFrame>;
  if (widget.type === 'progress') return (
    <WidgetFrame kind="progress" title={widget.title}><div className="space-y-3">{widget.items.map((item) => { const max = item.max ?? 100; const pct = Math.max(0, Math.min(100, item.value / max * 100)); return <div key={item.label}><div className="mb-1 flex justify-between gap-4 text-xs"><span>{item.label}</span><span className="text-muted-foreground">{item.detail ?? `${item.value}/${max}`}</span></div><Progress value={pct} aria-label={item.label} aria-valuenow={Math.round(pct)} /></div>; })}</div></WidgetFrame>
  );
  if (widget.type === 'timeline') return (
    <WidgetFrame kind="timeline" title={widget.title}><ol className="space-y-3">{widget.items.map((item) => { const Icon = item.status === 'done' ? Check : item.status === 'current' ? Clock : Circle; return <li key={item.label} className="flex gap-2"><Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><div className="text-sm font-medium">{item.label}</div>{item.detail && <div className="text-xs text-muted-foreground">{item.detail}</div>}</div></li>; })}</ol></WidgetFrame>
  );
  // `w-max` is what makes the frame's scroller work at all: a table told to
  // fill its box shrinks to fit instead of overflowing, so the scroll bar never
  // appeared and the columns crushed together on a phone. Sized to its content
  // it overflows and the reader pushes it along, the same shape the sequence
  // diagram above already uses (bw-343e.2).
  return (
    <WidgetFrame kind="table" title={widget.title} className="overflow-x-auto"><table className="w-max min-w-full text-left text-xs"><thead className="border-b bg-muted/40"><tr>{widget.columns.map((column) => <th key={column} className="px-3 py-2 font-medium">{column}</th>)}</tr></thead><tbody>{widget.rows.map((row, index) => <tr key={index} className="border-b last:border-0">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 text-muted-foreground">{cell}</td>)}</tr>)}</tbody></table></WidgetFrame>
  );
}
