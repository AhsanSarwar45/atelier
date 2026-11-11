'use client';

import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SceneArtifact, SceneElement } from './visual-artifacts';
import { advanceScene, interpolatePose, sceneFrames, type Pose } from './scene-playback';

function routePosition(pose: Pose, paths: Map<string, SVGPathElement>) {
  const path = pose.along && paths.get(pose.along);
  if (path) {
    try { return path.getPointAtLength(path.getTotalLength() * (pose.progress ?? 0)); }
    catch { /* Invalid SVG geometry must not break the transcript. */ }
  }
  return { x: pose.x, y: pose.y };
}

function ScenePrimitive({ element, from, to, fraction, paths }: { element: SceneElement; from: Pose; to: Pose; fraction: number; paths: Map<string, SVGPathElement> }) {
  const pose = interpolatePose(from, to, fraction);
  const { id, type, text, ...attributes } = element;
  let { x, y } = routePosition(pose, paths);
  // When leaving a route, interpolate from its actual endpoint rather than
  // the object's local origin. This also makes backwards seeking continuous.
  if (from.along && !to.along) {
    const start = routePosition(from, paths);
    x = start.x + (to.x - start.x) * fraction;
    y = start.y + (to.y - start.y) * fraction;
  }
  return <g data-element={id} transform={`translate(${x} ${y})`} opacity={pose.opacity}>
    {createElement(type, {
      ...attributes,
      style: { transform: `rotate(${pose.rotate}deg) scale(${pose.scale})`, transformBox: 'fill-box', transformOrigin: 'center' },
      ...(type !== 'text' && pose.pathLength !== 1 ? { pathLength: 1, strokeDasharray: `${Math.max(0, pose.pathLength)} 1` } : {}),
      vectorEffect: 'non-scaling-stroke',
    }, type === 'text' ? text : undefined)}
  </g>;
}

function ScenarioPlayer({ artifact, steps }: { artifact: SceneArtifact; steps: string[] }) {
  const frames = useMemo(() => sceneFrames(artifact, steps), [artifact, steps]);
  const durations = useMemo(() => frames.map(frame => frame.state.duration ?? 1.5), [frames]);
  const paths = useMemo(() => {
    const paths = new Map<string, SVGPathElement>();
    if (typeof document !== 'undefined') for (const element of artifact.elements) if (element.type === 'path' && element.d) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', element.d); paths.set(element.id, path);
    }
    return paths;
  }, [artifact]);
  const [position, setPosition] = useState(0);
  const cursor = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!preference) return;
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  const last = frames.length - 1;
  const seek = (value: number) => { setPlaying(false); cursor.current = value; setPosition(value); };
  useEffect(() => {
    if (!playing || reducedMotion) return;
    let raf: number; let previous: number | undefined;
    const tick = (now: number) => {
      const elapsed = previous === undefined ? 0 : (now - previous) / 1000;
      previous = now;
      cursor.current = advanceScene(cursor.current, elapsed, durations);
      setPosition(cursor.current);
      if (cursor.current >= last) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, reducedMotion, durations, last]);
  useEffect(() => { if (reducedMotion) setPlaying(false); }, [reducedMotion]);
  useEffect(() => {
    const pause = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener('visibilitychange', pause);
    return () => document.removeEventListener('visibilitychange', pause);
  }, []);
  const from = frames[Math.floor(position)]!;
  const to = frames[Math.ceil(position)]!;
  const fraction = position % 1;
  // During travel the narration tells the reader what is happening next.
  const state = to.state;
  const play = () => {
    if (playing) { setPlaying(false); return; }
    if (cursor.current >= last) { cursor.current = 0; setPosition(0); }
    setPlaying(true);
  };
  return <>
    <div className="max-w-full overflow-x-auto"><svg viewBox={artifact.viewBox.join(' ')} role="img" aria-label={`${artifact.title}: ${state.label}`} className="max-h-[36rem] min-w-[32rem] w-full overflow-visible rounded-xl bg-muted/20">
      {artifact.elements.map(element => <ScenePrimitive key={element.id} element={element} from={from.poses[element.id]!} to={to.poses[element.id]!} fraction={fraction} paths={paths} />)}
    </svg></div>
    <div className="mt-3 grid gap-3">
      <div aria-live={playing ? 'off' : 'polite'} aria-atomic="true" className="min-h-14 text-sm">
        <p className="font-medium"><span className="mr-2 text-muted-foreground">Step {Math.ceil(position) + 1} of {frames.length}</span>{state.label}</p>
        {state.detail && <p className="mt-1 text-muted-foreground">{state.detail}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={play} disabled={last === 0 || !!reducedMotion}>{playing ? <Pause /> : <Play />}{playing ? 'Pause' : 'Play'}</Button>
        <Button size="sm" variant="outline" onClick={() => { seek(0); if (!reducedMotion && last > 0) setPlaying(true); }} disabled={last === 0}><RotateCcw />Replay</Button>
        <div className="flex min-w-48 flex-1 items-center gap-2">
        <Button size="icon" variant="ghost" aria-label="Previous step" disabled={position === 0} onClick={() => seek(Math.max(0, Math.ceil(position) - 1))}><ChevronLeft /></Button>
        <Slider aria-label="Playback position" aria-valuetext={`Step ${Math.ceil(position) + 1} of ${frames.length}: ${state.label}`} min={0} max={last || 1} step={.01} value={position} disabled={last === 0} className="min-w-20" onChange={event => seek(Number(event.target.value))} onKeyDown={event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(event.key === 'ArrowLeft' ? Math.max(0, Math.ceil(position) - 1) : Math.min(last, Math.floor(position) + 1)); }
        }} />
        <Button size="icon" variant="ghost" aria-label="Next step" disabled={position === last} onClick={() => seek(Math.min(last, Math.floor(position) + 1))}><ChevronRight /></Button>
        </div>
      </div>
      {reducedMotion && <p className="text-xs text-muted-foreground">Reduced motion is on. Use the step controls to explore.</p>}
    </div>
  </>;
}

export function SceneView({ artifact }: { artifact: SceneArtifact }) {
  const scenarios = useMemo(() => artifact.scenarios ?? [{ id: 'default', label: artifact.title, steps: artifact.states.map(state => state.id) }], [artifact]);
  const [scenarioId, setScenarioId] = useState(scenarios[0]!.id);
  const scenario = scenarios.find(item => item.id === scenarioId) ?? scenarios[0]!;
  return <div data-testid="scene-artifact" className="p-3">
    {scenarios.length > 1 && <div className="mb-3 flex items-center gap-3"><span className="text-sm text-muted-foreground">Scenario</span>
      <Select value={scenario.id} onValueChange={setScenarioId}><SelectTrigger aria-label="Scenario" className="w-auto max-w-full"><SelectValue /></SelectTrigger><SelectContent>{scenarios.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select>
    </div>}
    <ScenarioPlayer key={scenario.id} artifact={artifact} steps={scenario.steps} />
  </div>;
}
