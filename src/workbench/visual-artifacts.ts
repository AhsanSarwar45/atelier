export type ArtifactKind = 'mermaid' | 'flow' | 'scene' | 'mockup';

type BaseArtifact = { version: 1; kind: ArtifactKind; title: string; description?: string };
export type MermaidArtifact = BaseArtifact & { kind: 'mermaid'; source: string };
export type FlowArtifact = BaseArtifact & {
  kind: 'flow'; direction?: 'RIGHT' | 'DOWN'; editable?: boolean;
  nodes: Array<{ id: string; label: string; detail?: string; color?: string }>;
  edges: Array<{ id: string; from: string; to: string; label?: string; animated?: boolean }>;
};
export type SceneElement = {
  id: string; type: 'rect' | 'circle' | 'ellipse' | 'line' | 'path' | 'polygon' | 'text';
  x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number;
  width?: number; height?: number; cx?: number; cy?: number; r?: number; rx?: number; ry?: number;
  d?: string; points?: string; text?: string; fill?: string; stroke?: string; strokeWidth?: number;
};
export type SceneArtifact = BaseArtifact & {
  kind: 'scene'; viewBox: [number, number, number, number]; elements: SceneElement[];
  states: Array<{ id: string; label: string; duration?: number; changes: Array<{
    element: string; opacity?: number; x?: number; y?: number; scale?: number; rotate?: number; pathLength?: number;
  }> }>;
};
export type MockupAction = { type: 'navigate'; screen: string } | { type: 'toggle'; target: string };
export type MockupComponent = {
  id: string; type: 'heading' | 'text' | 'button' | 'input' | 'badge' | 'card' | 'stack' | 'divider';
  text?: string; label?: string; placeholder?: string; tone?: 'primary' | 'neutral' | 'success' | 'warning';
  action?: MockupAction; children?: MockupComponent[];
};
export type MockupArtifact = BaseArtifact & {
  kind: 'mockup'; initialScreen: string; viewport?: { width: number; height: number };
  screens: Array<{ id: string; title: string; components: MockupComponent[] }>;
};
export type VisualArtifact = MermaidArtifact | FlowArtifact | SceneArtifact | MockupArtifact;

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fieldsAre = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).every((key) => fields.includes(key));
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);

function validComponents(components: unknown, ids: Set<string>, depth = 0): components is MockupComponent[] {
  if (!Array.isArray(components) || components.length > 60 || depth > 5) return false;
  return components.every((item) => {
    if (!object(item) || !fieldsAre(item, ['id', 'type', 'text', 'label', 'placeholder', 'tone', 'action', 'children'])
      || !id(item.id) || ids.has(item.id) || !['heading', 'text', 'button', 'input', 'badge', 'card', 'stack', 'divider'].includes(String(item.type))) return false;
    ids.add(item.id);
    if ([item.text, item.label, item.placeholder].some((value) => value !== undefined && !text(value))) return false;
    if (item.tone !== undefined && !['primary', 'neutral', 'success', 'warning'].includes(String(item.tone))) return false;
    if (item.action !== undefined && (!object(item.action) || !fieldsAre(item.action, ['type', 'screen', 'target'])
      || (item.action.type === 'navigate' ? !id(item.action.screen) : item.action.type === 'toggle' ? !id(item.action.target) : true))) return false;
    return item.children === undefined || validComponents(item.children, ids, depth + 1);
  });
}

export function visualArtifact(value: unknown): VisualArtifact | null {
  if (!object(value) || value.version !== 1 || !text(value.title) || !['mermaid', 'flow', 'scene', 'mockup'].includes(String(value.kind))
    || (value.description !== undefined && !text(value.description, 1000))) return null;
  if (value.kind === 'mermaid') {
    return fieldsAre(value, ['version', 'kind', 'title', 'description', 'source']) && text(value.source, 50_000) ? value as MermaidArtifact : null;
  }
  if (value.kind === 'flow') {
    if (!fieldsAre(value, ['version', 'kind', 'title', 'description', 'direction', 'editable', 'nodes', 'edges'])
      || (value.direction !== undefined && !['RIGHT', 'DOWN'].includes(String(value.direction)))
      || (value.editable !== undefined && typeof value.editable !== 'boolean')
      || !Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 100) return null;
    const nodeIds = new Set<string>();
    if (!value.nodes.every((node) => object(node) && fieldsAre(node, ['id', 'label', 'detail', 'color']) && id(node.id) && !nodeIds.has(node.id)
      && (nodeIds.add(node.id), true) && text(node.label) && (node.detail === undefined || text(node.detail)) && (node.color === undefined || text(node.color)))) return null;
    if (!Array.isArray(value.edges) || value.edges.length > 200 || !value.edges.every((edge) => object(edge)
      && fieldsAre(edge, ['id', 'from', 'to', 'label', 'animated']) && id(edge.id) && id(edge.from) && id(edge.to)
      && nodeIds.has(edge.from as string) && nodeIds.has(edge.to as string) && (edge.label === undefined || text(edge.label))
      && (edge.animated === undefined || typeof edge.animated === 'boolean'))) return null;
    return value as FlowArtifact;
  }
  if (value.kind === 'scene') {
    if (!fieldsAre(value, ['version', 'kind', 'title', 'description', 'viewBox', 'elements', 'states'])
      || !Array.isArray(value.viewBox) || value.viewBox.length !== 4 || !value.viewBox.every(finite)
      || !Array.isArray(value.elements) || value.elements.length < 1 || value.elements.length > 200) return null;
    const elementIds = new Set<string>();
    const elementFields = ['id', 'type', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'text', 'fill', 'stroke', 'strokeWidth'];
    if (!value.elements.every((element) => object(element) && fieldsAre(element, elementFields) && id(element.id) && !elementIds.has(element.id)
      && (elementIds.add(element.id), true) && ['rect', 'circle', 'ellipse', 'line', 'path', 'polygon', 'text'].includes(String(element.type))
      && Object.entries(element).every(([key, entry]) => ['id', 'type', 'd', 'points', 'text', 'fill', 'stroke'].includes(key) ? text(entry, 10_000) : finite(entry)))) return null;
    if (!Array.isArray(value.states) || value.states.length < 1 || value.states.length > 30 || !value.states.every((state) => object(state)
      && fieldsAre(state, ['id', 'label', 'duration', 'changes']) && id(state.id) && text(state.label)
      && (state.duration === undefined || (finite(state.duration) && state.duration >= 0 && state.duration <= 30))
      && Array.isArray(state.changes) && state.changes.length <= 200 && state.changes.every((change) => object(change)
        && fieldsAre(change, ['element', 'opacity', 'x', 'y', 'scale', 'rotate', 'pathLength']) && id(change.element)
        && elementIds.has(change.element as string) && Object.entries(change).every(([key, entry]) => key === 'element' ? true : finite(entry))))) return null;
    return value as SceneArtifact;
  }
  if (!fieldsAre(value, ['version', 'kind', 'title', 'description', 'initialScreen', 'viewport', 'screens']) || !id(value.initialScreen)
    || (value.viewport !== undefined && (!object(value.viewport) || !fieldsAre(value.viewport, ['width', 'height'])
      || !finite(value.viewport.width) || !finite(value.viewport.height) || value.viewport.width < 320 || value.viewport.width > 1920 || value.viewport.height < 240 || value.viewport.height > 1200))
    || !Array.isArray(value.screens) || value.screens.length < 1 || value.screens.length > 20) return null;
  const screenIds = new Set<string>(); const componentIds = new Set<string>();
  if (!value.screens.every((screen) => object(screen) && fieldsAre(screen, ['id', 'title', 'components']) && id(screen.id) && !screenIds.has(screen.id)
    && (screenIds.add(screen.id), true) && text(screen.title) && validComponents(screen.components, componentIds))) return null;
  if (!screenIds.has(value.initialScreen as string)) return null;
  for (const screen of value.screens as unknown as MockupArtifact['screens']) {
    const visit = (items: MockupComponent[]): boolean => items.every((item) => (!item.action
      || (item.action.type === 'navigate' ? screenIds.has(item.action.screen) : componentIds.has(item.action.target))) && (!item.children || visit(item.children)));
    if (!visit(screen.components)) return null;
  }
  return value as MockupArtifact;
}

export function canonicalArtifact(value: unknown): string | null {
  const artifact = visualArtifact(value);
  const order = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(order) : object(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, order(entry[key])])) : entry;
  return artifact ? `${JSON.stringify(order(artifact))}\n` : null;
}
