'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { RenderArtifact } from './render-model';
import { displayRender, renderPixel, type RenderFrames } from './render-engine';

type Pixel = { x: number; y: number };
const format = (n: number) => Number(n.toPrecision(7)).toString();
function BufferImage({ model, data, buffer, view, pixel, onPixel }: {
  model: RenderArtifact; data: Float32Array; buffer: number; view: RenderArtifact['views'][number]; pixel: Pixel; onPixel: (pixel: Pixel) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d'); if (!context) return;
    const rgba = displayRender(data, model.buffers[buffer]!.channels.length, view);
    const image = context.createImageData(model.width, model.height); image.data.set(rgba);
    context.putImageData(image, 0, 0);
    context.strokeStyle = '#000'; context.lineWidth = 1;
    context.strokeRect(pixel.x + .5, pixel.y + .5, 1, 1);
    context.strokeStyle = '#fff'; context.lineWidth = .4;
    context.strokeRect(pixel.x + .2, pixel.y + .2, .6, .6);
  }, [data, model, buffer, view, pixel]);
  const select = (x: number, y: number) => onPixel({ x: Math.max(0, Math.min(model.width - 1, x)), y: Math.max(0, Math.min(model.height - 1, y)) });
  return <canvas ref={canvas} width={model.width} height={model.height} role="button" tabIndex={0}
    aria-label={`Inspect ${view.label}. Pixel ${pixel.x}, ${pixel.y}. Use arrow keys to move.`}
    data-buffer={model.buffers[buffer]!.id} data-pixel={`${pixel.x},${pixel.y}`}
    className="block w-full cursor-crosshair rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" style={{ imageRendering: 'pixelated' }}
    onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); select(Math.floor((event.clientX - rect.left) / rect.width * model.width), Math.floor((event.clientY - rect.top) / rect.height * model.height)); }}
    onKeyDown={event => {
      const offset = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (offset) { event.preventDefault(); select(pixel.x + offset[0]!, pixel.y + offset[1]!); }
    }} />;
}

export function RenderView({ artifact: model }: { artifact: RenderArtifact }) {
  const id = useId();
  const defaults = useMemo(() => Object.fromEntries(model.parameters.map(p => [p.id, p.value])), [model]);
  const [parameters, setParameters] = useState(defaults);
  const [result, setResult] = useState<{ frames?: RenderFrames; error?: string }>({});
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [pixel, setPixel] = useState<Pixel>({ x: Math.floor(model.width / 2), y: Math.floor(model.height / 2) });
  const [inspect, setInspect] = useState(model.buffers[0]!.id);
  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)'); if (!preference) return;
    const update = () => { setReducedMotion(preference.matches); if (preference.matches) setPlaying(false); };
    update(); preference.addEventListener('change', update); return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const pause = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener('visibilitychange', pause); return () => document.removeEventListener('visibilitychange', pause);
  }, []);
  useEffect(() => {
    setPlaying(false); setResult({});
    let active = true; let worker: Worker | undefined;
    const timer = setTimeout(() => { if (active) { active = false; worker?.terminate(); setResult({ error: 'Computation timed out. Reduce the model size.' }); } }, 10000);
    try {
      worker = new Worker(new URL('./render-worker.ts', import.meta.url));
      worker.onmessage = event => { if (active) { clearTimeout(timer); setResult(event.data); } };
      worker.onerror = () => { if (active) { clearTimeout(timer); setResult({ error: 'Could not compute this model.' }); } };
      worker.postMessage({ model, parameters });
    } catch { clearTimeout(timer); setResult({ error: 'Could not start the rendering worker.' }); }
    return () => { active = false; clearTimeout(timer); worker?.terminate(); };
  }, [model, parameters]);
  useEffect(() => {
    if (!playing || reducedMotion || !result.frames) return;
    const interval = setInterval(() => setFrame(f => Math.min(model.frames - 1, f + 1)), 1000 / model.fps);
    return () => clearInterval(interval);
  }, [playing, reducedMotion, result.frames, model.frames, model.fps]);
  useEffect(() => { if (frame === model.frames - 1) setPlaying(false); }, [frame, model.frames]);
  const seek = (value: number) => { setPlaying(false); setFrame(value); };
  const inspectIndex = Math.max(0, model.buffers.findIndex(b => b.id === inspect));
  const data = result.frames?.[frame];
  const inspectView = useMemo<RenderArtifact['views'][number]>(() => {
    const buffer = model.buffers[inspectIndex]!;
    const declared = model.views.find(v => v.buffer === buffer.id);
    if (declared) return { ...declared, label: buffer.label };
    const values = data?.[inspectIndex]; let min = 0; let max = 1;
    if (values) for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
    const count = Math.min(3, buffer.channels.length);
    return { id: 'inspection', label: buffer.label, buffer: buffer.id, display: count === 3 ? 'rgb' : count === 2 ? 'vector' : 'scalar', channels: Array.from({ length: count }, (_, i) => i), range: [min, max] };
  }, [model, inspectIndex, data]);
  return <div data-testid="render-artifact" className="grid gap-4 p-3 pt-14" aria-busy={!result.frames && !result.error}>
    {model.description && <p className="text-sm text-muted-foreground">{model.description}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      {model.parameters.map(p => <label key={p.id} className="grid gap-2 text-sm" htmlFor={`${id}-${p.id}`}>
        <span>{p.label} <output className="float-right tabular-nums">{format(parameters[p.id]!)}</output></span>
        <Slider id={`${id}-${p.id}`} aria-label={p.label} min={p.min} max={p.max} step={p.step} value={parameters[p.id]} onChange={e => { setPlaying(false); setResult({}); setParameters(current => ({ ...current, [p.id]: Number(e.target.value) })); }} />
      </label>)}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={!data || reducedMotion || model.frames === 1} onClick={() => { if (playing) setPlaying(false); else { if (frame === model.frames - 1) setFrame(0); setPlaying(true); } }}>{playing ? <Pause /> : <Play />}{playing ? 'Pause' : 'Play'}</Button>
      <Button size="sm" variant="outline" disabled={!data || model.frames === 1} onClick={() => { setFrame(0); setPlaying(!reducedMotion); }}><RotateCcw />Replay</Button>
      <Button size="sm" variant="ghost" onClick={() => { setPlaying(false); setFrame(0); setResult({}); setParameters({ ...defaults }); }}>Reset parameters</Button>
      <span className="text-sm tabular-nums" data-testid="render-frame">Frame {frame} / {model.frames - 1}</span>
    </div>
    <div className="flex items-center gap-2">
      <Button size="icon" variant="ghost" aria-label="Previous frame" disabled={!data || frame === 0} onClick={() => seek(frame - 1)}><ChevronLeft /></Button>
      <Slider aria-label="Frame" min={0} max={model.frames - 1 || 1} step={1} value={frame} disabled={!data || model.frames === 1} onChange={e => seek(Number(e.target.value))} />
      <Button size="icon" variant="ghost" aria-label="Next frame" disabled={!data || frame === model.frames - 1} onClick={() => seek(frame + 1)}><ChevronRight /></Button>
    </div>
    {reducedMotion && <p className="text-xs text-muted-foreground">Reduced motion is on. Use the frame controls to explore.</p>}
    {result.error ? <p role="alert" className="text-sm text-destructive">{result.error}</p> : !data ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">Computing frames…</p> : <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {model.views.map(view => {
          const buffer = model.buffers.findIndex(b => b.id === view.buffer);
          const values = renderPixel(data[buffer]!, model, buffer, pixel.x, pixel.y);
          return <Panel key={view.id} inset="sm" className="min-w-0 space-y-2" data-view={view.id} data-frame={frame}>
            <h3 className="text-sm font-medium">{view.label}</h3>
            <BufferImage model={model} data={data[buffer]!} buffer={buffer} view={view} pixel={pixel} onPixel={setPixel} />
            <p className="break-words text-xs tabular-nums text-muted-foreground">{model.buffers[buffer]!.channels.map((name, c) => `${name}: ${format(values[c]!)}`).join(' · ')}</p>
            <p className="text-xs text-muted-foreground">Display {view.range.join(' to ')}{view.encoding === 'linear' ? ' · linear RGB to sRGB' : ''}{view.display === 'vector' ? ' · first channel: red; second: green' : ''}</p>
          </Panel>;
        })}
      </div>
      <Panel inset="md" className="min-w-0 space-y-3">
        <h3 className="text-sm font-medium">Pixel inspector</h3>
        <p className="text-xs text-muted-foreground">Click any image or use arrow keys. Selection is shared across all panes. Values below are raw buffer samples.</p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">X<Input className="w-20" type="number" aria-label="Pixel X" min={0} max={model.width - 1} value={pixel.x} onChange={e => { if (e.target.value !== '') setPixel(p => ({ ...p, x: Math.max(0, Math.min(model.width - 1, Math.floor(Number(e.target.value)))) })); }} /></label>
          <label className="flex items-center gap-2 text-sm">Y<Input className="w-20" type="number" aria-label="Pixel Y" min={0} max={model.height - 1} value={pixel.y} onChange={e => { if (e.target.value !== '') setPixel(p => ({ ...p, y: Math.max(0, Math.min(model.height - 1, Math.floor(Number(e.target.value)))) })); }} /></label>
          <Select value={inspect} onValueChange={setInspect}><SelectTrigger aria-label="Inspect buffer" className="w-auto"><SelectValue /></SelectTrigger><SelectContent>{model.buffers.map(b => <SelectItem key={b.id} value={b.id}>{b.label}</SelectItem>)}</SelectContent></Select>
        </div>
        <div className="max-w-xs"><BufferImage model={model} data={data[inspectIndex]!} buffer={inspectIndex} view={inspectView} pixel={pixel} onPixel={setPixel} /></div>
        <p className="text-xs text-muted-foreground">{inspectView.display} display · {inspectView.range.join(' to ')}{inspectView.display === 'vector' ? ' · first channel: red; second: green' : ''}</p>
        <Table aria-label="Pixel buffer values"><TableHeader><TableRow><TableHead>Buffer</TableHead><TableHead>Current frame</TableHead><TableHead>Previous frame</TableHead></TableRow></TableHeader>
          <TableBody>{model.buffers.map((b, index) => {
            const values = renderPixel(data[index]!, model, index, pixel.x, pixel.y);
            const previous = frame > 0 ? renderPixel(result.frames![frame - 1]![index]!, model, index, pixel.x, pixel.y) : b.initial ?? b.channels.map(() => 0);
            const describe = (samples: number[]) => b.channels.map((name, c) => `${name}: ${format(samples[c]!)}`).join(' · ');
            return <TableRow key={b.id} data-buffer-row={b.id}><TableCell>{b.label}</TableCell><TableCell className="tabular-nums">{describe(values)}</TableCell><TableCell className="tabular-nums">{describe(previous)}</TableCell></TableRow>;
          })}</TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">Previous-frame values use the same pixel coordinates; frame 0 shows initial values.</p>
      </Panel>
    </>}
  </div>;
}
