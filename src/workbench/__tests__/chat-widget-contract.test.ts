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
  ])('refuses malformed $type widgets and leaves their source visible', (value) => {
    const source = block(value);
    expect(widgetSpecs(source)).toEqual([]);
    expect(withoutWidgetSpecs(source)).toBe(source);
  });
});
