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
export type ChatWidget = MetricWidget | ChartWidget | ProgressWidget | TimelineWidget | TableWidget;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const title = (value: unknown) => value === undefined || text(value);

export function widget(value: unknown): ChatWidget | null {
  if (!object(value) || !text(value.type) || !title(value.title)) return null;
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
  const columns = value.columns;
  if (value.type === 'table' && Array.isArray(columns) && columns.length > 0 && columns.length <= 8
    && columns.every(text) && Array.isArray(value.rows) && value.rows.length <= 30
    && value.rows.every((row) => Array.isArray(row) && row.length === columns.length && row.every(text))) return value as TableWidget;
  return null;
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
