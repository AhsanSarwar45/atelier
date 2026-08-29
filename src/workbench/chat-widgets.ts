const BLOCK = /```atelier-widget\s*\n([\s\S]*?)\n```/g;

export type MetricWidget = {
  type: 'metrics'; title?: string;
  items: Array<{ label: string; value: string; detail?: string; trend?: 'up' | 'down' | 'flat' }>;
};
export type ChartWidget = {
  type: 'chart'; chart: 'bar' | 'line'; title?: string;
  series: Array<{ name: string; color?: string }>;
  data: Array<{ label: string; values: number[] }>;
};
export type ProgressWidget = {
  type: 'progress'; title?: string;
  items: Array<{ label: string; value: number; max?: number; detail?: string }>;
};
export type TimelineWidget = {
  type: 'timeline'; title?: string;
  items: Array<{ label: string; detail?: string; status?: 'done' | 'current' | 'next' }>;
};
export type TableWidget = {
  type: 'table'; title?: string; columns: string[]; rows: string[][];
};
export type VideoWidget = {
  type: 'video'; title?: string; src: string; poster?: string;
};
export type ImageWidget = {
  type: 'image'; title?: string; asset: string; alt: string; caption?: string;
};
export type ImageCompareWidget = {
  type: 'image_compare'; title?: string; mode: 'side_by_side' | 'wipe';
  before: { asset: string; alt: string }; after: { asset: string; alt: string };
};
export type ExplainerWidget = {
  type: 'explainer';
  layout?: 'flow' | 'sequence' | 'cycle' | 'layers';
  title?: string;
  summary?: string;
  nodes: Array<{ id: string; label: string; detail?: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
  steps: Array<{ label: string; detail?: string; active: string[] }>;
  evidence?: Array<{ label: string; path: string; line?: number }>;
};
export type ChatWidget = MetricWidget | ChartWidget | ProgressWidget | TimelineWidget | TableWidget | VideoWidget | ImageWidget | ImageCompareWidget | ExplainerWidget;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const title = (value: unknown) => value === undefined || text(value);
const mediaSource = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 4096
  && (/^(https?:|data:video\/|blob:|file:)/.test(value) || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value));
const path = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 4096
  && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value));
const asset = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(value);

export function widget(value: unknown): ChatWidget | null {
  if (!object(value) || !text(value.type) || !title(value.title)) return null;
  const nodes = value.nodes;
  const edges = value.edges;
  const steps = value.steps;
  if (value.type === 'metrics' && Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 6) {
    const items = value.items;
    if (items.every((item) => object(item) && text(item.label) && text(item.value)
      && (item.detail === undefined || text(item.detail))
      && (item.trend === undefined || ['up', 'down', 'flat'].includes(String(item.trend))))) return value as MetricWidget;
  }
  const series = value.series;
  if (value.type === 'chart' && (value.chart === 'bar' || value.chart === 'line')
    && Array.isArray(series) && series.length > 0 && series.length <= 4
    && series.every((item) => object(item) && text(item.name) && (item.color === undefined || text(item.color)))
    && Array.isArray(value.data) && value.data.length > 0 && value.data.length <= 30
    && value.data.every((item) => object(item) && text(item.label) && Array.isArray(item.values)
      && item.values.length === series.length && item.values.every((n) => typeof n === 'number' && Number.isFinite(n)))) return value as ChartWidget;
  if (value.type === 'progress' && Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 12
    && value.items.every((item) => object(item) && text(item.label) && typeof item.value === 'number' && Number.isFinite(item.value)
      && (item.max === undefined || (typeof item.max === 'number' && Number.isFinite(item.max) && item.max > 0))
      && (item.detail === undefined || text(item.detail)))) return value as ProgressWidget;
  if (value.type === 'timeline' && Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 20
    && value.items.every((item) => object(item) && text(item.label) && (item.detail === undefined || text(item.detail))
      && (item.status === undefined || ['done', 'current', 'next'].includes(String(item.status))))) return value as TimelineWidget;
  if (value.type === 'video' && mediaSource(value.src)
    && (value.poster === undefined || mediaSource(value.poster))) return value as VideoWidget;
  if (value.type === 'image' && asset(value.asset) && text(value.alt)
    && (value.caption === undefined || text(value.caption))) return value as ImageWidget;
  if (value.type === 'image_compare' && (value.mode === 'side_by_side' || value.mode === 'wipe')
    && object(value.before) && asset(value.before.asset) && text(value.before.alt)
    && object(value.after) && asset(value.after.asset) && text(value.after.alt)) return value as ImageCompareWidget;
  if (value.type === 'explainer' && (value.layout === undefined || ['flow', 'sequence', 'cycle', 'layers'].includes(String(value.layout)))
    && (value.summary === undefined || text(value.summary))
    && Array.isArray(nodes) && nodes.length >= 2 && nodes.length <= 12
    && nodes.every((node) => object(node) && text(node.id) && text(node.label)
      && (node.detail === undefined || text(node.detail)))
    && new Set(nodes.map((node) => object(node) ? node.id : null)).size === nodes.length
    && Array.isArray(edges) && edges.length > 0 && edges.length <= 20
    && edges.every((edge) => object(edge) && text(edge.from) && text(edge.to)
      && (edge.label === undefined || text(edge.label))
      && nodes.some((node) => object(node) && node.id === edge.from)
      && nodes.some((node) => object(node) && node.id === edge.to))
    && Array.isArray(steps) && steps.length > 0 && steps.length <= 12
    && steps.every((step) => object(step) && text(step.label)
      && (step.detail === undefined || text(step.detail))
      && Array.isArray(step.active) && step.active.length > 0
      && step.active.every((id) => text(id) && nodes.some((node) => object(node) && node.id === id)))
    && (value.evidence === undefined || (Array.isArray(value.evidence) && value.evidence.length <= 12
      && value.evidence.every((item) => object(item) && text(item.label) && path(item.path)
        && (item.line === undefined || (Number.isInteger(item.line) && Number(item.line) > 0)))))) return value as ExplainerWidget;
  const columns = value.columns;
  if (value.type === 'table' && Array.isArray(columns) && columns.length > 0 && columns.length <= 8
    && columns.every(text) && Array.isArray(value.rows) && value.rows.length <= 30
    && value.rows.every((row) => Array.isArray(row) && row.length === columns.length && row.every(text))) return value as TableWidget;
  return null;
}

const TOP_LEVEL_FIELDS: Record<ChatWidget['type'], Set<string>> = {
  metrics: new Set(['type', 'title', 'items']),
  chart: new Set(['type', 'title', 'chart', 'series', 'data']),
  progress: new Set(['type', 'title', 'items']),
  timeline: new Set(['type', 'title', 'items']),
  table: new Set(['type', 'title', 'columns', 'rows']),
  video: new Set(['type', 'title', 'src', 'poster']),
  image: new Set(['type', 'title', 'asset', 'alt', 'caption']),
  image_compare: new Set(['type', 'title', 'mode', 'before', 'after']),
  explainer: new Set(['type', 'layout', 'title', 'summary', 'nodes', 'edges', 'steps', 'evidence']),
};

const fieldsAre = (value: Record<string, unknown>, allowed: Set<string>) =>
  Object.keys(value).every((key) => allowed.has(key));

/** Strict input for the presentation CLI; transcript parsing stays backward-compatible. */
export function presentableWidget(value: unknown): ChatWidget | null {
  const parsed = widget(value);
  if (!parsed || !fieldsAre(parsed as unknown as Record<string, unknown>, TOP_LEVEL_FIELDS[parsed.type])) return null;
  if (parsed.type === 'metrics') return parsed.items.every((item) => fieldsAre(item, new Set(['label', 'value', 'detail', 'trend']))) ? parsed : null;
  if (parsed.type === 'chart') return parsed.series.every((item) => fieldsAre(item, new Set(['name', 'color'])))
    && parsed.data.every((item) => fieldsAre(item, new Set(['label', 'values']))) ? parsed : null;
  if (parsed.type === 'progress') return parsed.items.every((item) => fieldsAre(item, new Set(['label', 'value', 'max', 'detail']))) ? parsed : null;
  if (parsed.type === 'timeline') return parsed.items.every((item) => fieldsAre(item, new Set(['label', 'detail', 'status']))) ? parsed : null;
  if (parsed.type === 'explainer') return parsed.nodes.every((item) => fieldsAre(item, new Set(['id', 'label', 'detail'])))
    && parsed.edges.every((item) => fieldsAre(item, new Set(['from', 'to', 'label'])))
    && parsed.steps.every((item) => fieldsAre(item, new Set(['label', 'detail', 'active'])))
    && (parsed.evidence === undefined || parsed.evidence.every((item) => fieldsAre(item, new Set(['label', 'path', 'line'])))) ? parsed : null;
  if (parsed.type === 'image_compare') return fieldsAre(parsed.before, new Set(['asset', 'alt']))
    && fieldsAre(parsed.after, new Set(['asset', 'alt'])) ? parsed : null;
  return parsed;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
}

/** Exact durable transcript syntax returned by Atelier's bundled presenter. */
export function widgetBlock(value: unknown): string | null {
  const parsed = presentableWidget(value);
  return parsed ? `\`\`\`atelier-widget\n${JSON.stringify(ordered(parsed))}\n\`\`\`` : null;
}

export function widgetSpecs(message: string): ChatWidget[] {
  const found: ChatWidget[] = [];
  const blocks = new RegExp(BLOCK.source, BLOCK.flags);
  let match: RegExpExecArray | null;
  while ((match = blocks.exec(message)) !== null) {
    try {
      const parsed = widget(JSON.parse(match[1]!));
      if (parsed) found.push(parsed);
    } catch { /* Invalid blocks remain readable as source text. */ }
  }
  return found;
}

export function withoutWidgetSpecs(message: string): string {
  return message.replace(BLOCK, (whole, source: string) => {
    try { return widget(JSON.parse(source)) ? '' : whole; } catch { return whole; }
  }).trim();
}
