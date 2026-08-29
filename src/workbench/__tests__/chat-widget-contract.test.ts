import { describe, expect, it } from 'vitest';
import { widgetSpecs, withoutWidgetSpecs } from '@/workbench/chat-widgets';

const block = (body: unknown) => `Result\n\n\`\`\`atelier-widget\n${JSON.stringify(body)}\n\`\`\``;

describe('conversation widget contract', () => {
  it.each([
    { type: 'metrics', items: [{ label: 'Speed', value: '42 ms', trend: 'up' }] },
    { type: 'chart', chart: 'line', series: [{ name: 'Time' }], data: [{ label: 'Mon', values: [2] }] },
    { type: 'progress', items: [{ label: 'Tests', value: 8, max: 10 }] },
    { type: 'timeline', items: [{ label: 'Released', status: 'done' }] },
    { type: 'table', columns: ['Choice', 'Cost'], rows: [['A', '$2']] },
    { type: 'video', title: 'Proof', src: '/home/me/proof.webm' },
    { type: 'image', asset: `${'a'.repeat(64)}.png`, alt: 'Architecture' },
    { type: 'image_compare', mode: 'side_by_side', before: { asset: `${'b'.repeat(64)}.jpg`, alt: 'Before' }, after: { asset: `${'c'.repeat(64)}.webp`, alt: 'After' } },
    { type: 'explainer', title: 'A request', nodes: [{ id: 'web', label: 'Web' }, { id: 'api', label: 'API' }], edges: [{ from: 'web', to: 'api', label: 'HTTP' }], steps: [{ label: 'Send', active: ['web'] }, { label: 'Handle', active: ['api'] }], evidence: [{ label: 'Route', path: '/repo/api.ts', line: 42 }] },
    { type: 'explainer', layout: 'sequence', nodes: [{ id: 'web', label: 'Web' }, { id: 'api', label: 'API' }], edges: [{ from: 'web', to: 'api' }], steps: [{ label: 'Call', active: ['web', 'api'] }] },
    { type: 'explainer', layout: 'cycle', nodes: [{ id: 'plan', label: 'Plan' }, { id: 'build', label: 'Build' }], edges: [{ from: 'plan', to: 'build' }, { from: 'build', to: 'plan' }], steps: [{ label: 'Plan', active: ['plan'] }] },
    { type: 'explainer', layout: 'layers', nodes: [{ id: 'ui', label: 'UI' }, { id: 'db', label: 'DB' }], edges: [{ from: 'ui', to: 'db' }], steps: [{ label: 'Read', active: ['db'] }] },
  ])('accepts $type widgets and hides their valid source block', (value) => {
    expect(widgetSpecs(block(value))).toEqual([value]);
    expect(withoutWidgetSpecs(block(value))).toBe('Result');
  });

  it.each([
    { type: 'chart', chart: 'pie', series: [{ name: 'x' }], data: [{ label: 'x', values: [1] }] },
    { type: 'chart', chart: 'bar', series: [{ name: 'x' }], data: [{ label: 'x', values: [1, 2] }] },
    { type: 'progress', items: [{ label: 'x', value: 1, max: 0 }] },
    { type: 'table', columns: ['a', 'b'], rows: [['only one']] },
    { type: 'video', src: 'javascript:alert(1)' },
    { type: 'image', asset: '../secret.png', alt: 'Secret' },
    { type: 'image_compare', mode: 'side_by_side', before: { asset: `${'b'.repeat(64)}.jpg`, alt: 'Before' }, after: { asset: 'missing.png', alt: 'After' } },
    { type: 'explainer', nodes: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }], edges: [{ from: 'one', to: 'missing' }], steps: [{ label: 'Go', active: ['one'] }] },
    { type: 'explainer', nodes: [{ id: 'same', label: 'One' }, { id: 'same', label: 'Two' }], edges: [{ from: 'same', to: 'same' }], steps: [{ label: 'Go', active: ['same'] }] },
    { type: 'explainer', layout: 'orbit', nodes: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }], edges: [{ from: 'one', to: 'two' }], steps: [{ label: 'Go', active: ['one'] }] },
  ])('refuses malformed $type widgets and leaves their source visible', (value) => {
    const source = block(value);
    expect(widgetSpecs(source)).toEqual([]);
    expect(withoutWidgetSpecs(source)).toBe(source);
  });
});
