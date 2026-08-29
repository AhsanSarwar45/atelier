'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import mermaid from 'mermaid';
import { motion } from 'motion/react';
import '@xyflow/react/dist/style.css';

import { Button } from '@/components/ui/button';
import { apiUrl } from '@/lib/api-base';
import type { FlowArtifact, MermaidArtifact, SceneArtifact, SceneElement, VisualArtifact } from './visual-artifacts';
import { visualArtifact } from './visual-artifacts';

const artifactUrl = (asset: string) => apiUrl(`/api/presentation-assets/${encodeURIComponent(asset)}`);

export function useVisualArtifact(asset: string) {
  const [state, setState] = useState<{ artifact?: VisualArtifact; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    fetch(artifactUrl(asset), { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Artifact could not be loaded (${response.status})`);
      const parsed = visualArtifact(await response.json());
      if (!parsed) throw new Error('Stored artifact failed validation');
      setState({ artifact: parsed });
    }).catch((error) => { if (error?.name !== 'AbortError') setState({ error: error instanceof Error ? error.message : String(error) }); });
    return () => controller.abort();
  }, [asset]);
  return state;
}

function MermaidView({ artifact }: { artifact: MermaidArtifact }) {
  const rawId = useId(); const id = `mermaid-${rawId.replace(/[^a-z0-9]/gi, '')}`;
  const [svg, setSvg] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', flowchart: { htmlLabels: false } });
    mermaid.render(id, artifact.source).then(({ svg: rendered }) => { if (alive) setSvg(rendered); })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { alive = false; };
  }, [artifact.source, id]);
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">Diagram error: {error}</p>;
  return <div data-testid="mermaid-artifact" className="flex min-h-72 items-center justify-center overflow-auto p-4 [&_svg]:max-h-[36rem] [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function FlowView({ artifact }: { artifact: FlowArtifact }) {
  const initialNodes = useMemo<Node[]>(() => artifact.nodes.map((node, index) => ({
    id: node.id, position: { x: (index % 4) * 220, y: Math.floor(index / 4) * 130 },
    data: { label: <div className="min-w-32"><strong className="block">{node.label}</strong>{node.detail && <span className="text-xs opacity-70">{node.detail}</span>}</div> },
    style: { color: 'var(--color-foreground)', background: 'var(--color-surface-raised)', border: `1px solid ${node.color ?? 'var(--color-primary)'}`, borderRadius: 12 },
  })), [artifact.nodes]);
  const [nodes, setNodes] = useState(initialNodes);
  const edges = useMemo<Edge[]>(() => artifact.edges.map((edge) => ({ id: edge.id, source: edge.from, target: edge.to, label: edge.label, animated: edge.animated, style: { stroke: 'var(--color-primary)' } })), [artifact.edges]);
  useEffect(() => {
    const elk = new ELK();
    elk.layout({ id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': artifact.direction ?? 'RIGHT', 'elk.spacing.nodeNode': '48' },
      children: artifact.nodes.map((node) => ({ id: node.id, width: 180, height: 72 })), edges: artifact.edges.map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })) })
      .then((graph) => setNodes((current) => current.map((node) => { const placed = graph.children?.find((item) => item.id === node.id); return { ...node, position: { x: placed?.x ?? node.position.x, y: placed?.y ?? node.position.y } }; })))
      .catch(() => undefined);
  }, [artifact]);
  return <div data-testid="flow-artifact" className="h-[32rem] min-h-80"><ReactFlow nodes={nodes} edges={edges} nodesDraggable={artifact.editable ?? true} nodesConnectable={false} fitView attributionPosition="bottom-left"><Background /><Controls /></ReactFlow></div>;
}

function AnimatedElement({ element, animate, duration }: { element: SceneElement; animate: Record<string, number>; duration: number }) {
  const shared = { ...element, id: undefined, type: undefined, animate, transition: { duration, ease: 'easeInOut' as const }, vectorEffect: 'non-scaling-stroke' };
  if (element.type === 'rect') return <motion.rect {...shared} />;
  if (element.type === 'circle') return <motion.circle {...shared} />;
  if (element.type === 'ellipse') return <motion.ellipse {...shared} />;
  if (element.type === 'line') return <motion.line {...shared} />;
  if (element.type === 'path') return <motion.path {...shared} />;
  if (element.type === 'polygon') return <motion.polygon {...shared} />;
  return <motion.text {...shared}>{element.text}</motion.text>;
}

function SceneView({ artifact }: { artifact: SceneArtifact }) {
  const [step, setStep] = useState(0); const state = artifact.states[step]!;
  const changes = new Map(state.changes.map(({ element, ...change }) => [element, change]));
  return <div data-testid="scene-artifact" className="p-3">
    <svg viewBox={artifact.viewBox.join(' ')} role="img" aria-label={`${artifact.title}: ${state.label}`} className="max-h-[36rem] w-full overflow-visible rounded-xl bg-gradient-to-br from-muted/30 to-primary/5">
      {artifact.elements.map((element) => <AnimatedElement key={element.id} element={element} animate={changes.get(element.id) ?? {}} duration={state.duration ?? .7} />)}
    </svg>
    <div className="mt-3 flex flex-wrap items-center justify-center gap-2" aria-label="Animation states">
      {artifact.states.map((item, index) => <Button key={item.id} type="button" size="sm" variant={index === step ? 'primary' : 'outline'} aria-current={index === step ? 'step' : undefined} onClick={() => setStep(index)}>{item.label}</Button>)}
    </div>
  </div>;
}

export function VisualArtifactContent({ artifact }: { artifact: VisualArtifact }) {
  if (artifact.kind === 'mermaid') return <MermaidView artifact={artifact} />;
  if (artifact.kind === 'flow') return <FlowView artifact={artifact} />;
  if (artifact.kind === 'scene') return <SceneView artifact={artifact} />;
  return null;
}

export function VisualArtifactView({ asset }: { asset: string }) {
  const { artifact, error } = useVisualArtifact(asset);
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error}</p>;
  if (!artifact) return <div role="status" className="p-6 text-center text-sm text-muted-foreground">Loading visual…</div>;
  return <VisualArtifactContent artifact={artifact} />;
}
