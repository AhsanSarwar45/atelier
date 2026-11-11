/** A bounded numerical image model. Expressions are data, never JavaScript. */
export type RenderExpression = number | string | RenderExpression[];
export type RenderArtifact = {
  version: 1; kind: 'render'; title: string; description?: string;
  width: number; height: number; frames: number; fps: number;
  parameters: Array<{ id: string; label: string; min: number; max: number; step: number; value: number }>;
  buffers: Array<{ id: string; label: string; channels: string[]; values: RenderExpression[]; initial?: number[] }>;
  views: Array<{ id: string; label: string; buffer: string; display: 'rgb' | 'scalar' | 'vector'; channels: number[]; range: [number, number]; encoding?: 'linear' | 'raw' }>;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6;
const integer = (v: unknown, min: number, max: number): v is number => finite(v) && Number.isInteger(v) && v >= min && v <= max;
const label = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200;
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
export const renderArities: Record<string, number> = Object.fromEntries([
  ...['abs', 'floor', 'sin', 'cos', 'sqrt'].map(op => [op, 1]),
  ...['add', 'sub', 'mul', 'div', 'mod', 'min', 'max', 'lt', 'le', 'gt', 'ge', 'eq', 'and', 'or'].map(op => [op, 2]),
  ...['if', 'mix', 'clamp'].map(op => [op, 3]),
]);

export function renderArtifact(value: unknown): RenderArtifact | null {
  if (!object(value) || !fields(value, ['version', 'kind', 'title', 'description', 'width', 'height', 'frames', 'fps', 'parameters', 'buffers', 'views'])
    || value.version !== 1 || value.kind !== 'render' || !label(value.title)
    || (value.description !== undefined && (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1000))
    || !integer(value.width, 1, 64) || !integer(value.height, 1, 64) || !integer(value.frames, 1, 60) || !integer(value.fps, 1, 30)
    || !Array.isArray(value.parameters) || value.parameters.length > 8 || !Array.isArray(value.buffers) || value.buffers.length < 1 || value.buffers.length > 8
    || !Array.isArray(value.views) || value.views.length < 2 || value.views.length > 4) return null;
  const variables = new Set(['x', 'y', 'width', 'height', 'frame']);
  for (const p of value.parameters) {
    if (!object(p) || !fields(p, ['id', 'label', 'min', 'max', 'step', 'value']) || !identifier(p.id) || variables.has(p.id) || !label(p.label)
      || !finite(p.min) || !finite(p.max) || p.min >= p.max || !finite(p.step) || p.step <= 0 || p.step > p.max - p.min
      || !finite(p.value) || p.value < p.min || p.value > p.max) return null;
    variables.add(p.id);
  }
  const buffers = new Map<string, number>();
  for (const b of value.buffers) {
    if (!object(b) || !fields(b, ['id', 'label', 'channels', 'values', 'initial']) || !identifier(b.id) || buffers.has(b.id) || !label(b.label)
      || !Array.isArray(b.channels) || b.channels.length < 1 || b.channels.length > 4 || !b.channels.every(label) || new Set(b.channels).size !== b.channels.length
      || !Array.isArray(b.values) || b.values.length !== b.channels.length
      || (b.initial !== undefined && (!Array.isArray(b.initial) || b.initial.length !== b.channels.length || !b.initial.every(finite)))) return null;
    buffers.set(b.id, b.channels.length);
  }
  let nodes = 0;
  const available = new Set<string>();
  const expression = (v: unknown, depth = 0): boolean => {
    if (++nodes > 512 || depth > 12) return false;
    if (finite(v)) return true;
    if (typeof v === 'string') return variables.has(v);
    if (!Array.isArray(v) || typeof v[0] !== 'string') return false;
    if (v[0] === 'sample') return v.length === 6 && typeof v[1] === 'string' && buffers.has(v[1])
      && integer(v[2], 0, buffers.get(v[1])! - 1) && (v[5] === 'previous' || v[5] === 'current' && available.has(v[1]))
      && expression(v[3], depth + 1) && expression(v[4], depth + 1);
    return Object.hasOwn(renderArities, v[0]) && v.length === renderArities[v[0]]! + 1 && v.slice(1).every(item => expression(item, depth + 1));
  };
  for (const b of value.buffers as RenderArtifact['buffers']) {
    if (!b.values.every(v => expression(v))) return null;
    available.add(b.id);
  }
  if (value.width * value.height * value.frames * nodes > 6_000_000) return null;
  const views = new Set<string>();
  for (const v of value.views) {
    if (!object(v) || !fields(v, ['id', 'label', 'buffer', 'display', 'channels', 'range', 'encoding']) || !identifier(v.id) || views.has(v.id) || !label(v.label)
      || typeof v.buffer !== 'string' || !buffers.has(v.buffer) || !['rgb', 'scalar', 'vector'].includes(String(v.display))
      || !Array.isArray(v.channels) || v.channels.length !== (v.display === 'rgb' ? 3 : v.display === 'vector' ? 2 : 1)
      || !v.channels.every(c => integer(c, 0, buffers.get(v.buffer as string)! - 1))
      || !Array.isArray(v.range) || v.range.length !== 2 || !v.range.every(finite) || v.range[0] >= v.range[1]
      || (v.encoding !== undefined && (v.display !== 'rgb' || !['linear', 'raw'].includes(String(v.encoding))))) return null;
    views.add(v.id);
  }
  return value as RenderArtifact;
}
