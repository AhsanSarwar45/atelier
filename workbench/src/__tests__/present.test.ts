/** @vitest-environment node */
import { describe, expect, it } from 'vitest';

import { present } from '../present';
import { widgetSpecs } from '../../../src/workbench/chat-widgets';

describe('bundled presentation command', () => {
  it('prints one canonical widget block that the renderer accepts', () => {
    const output = present(['widget'], JSON.stringify({ items: [{ value: '42', label: 'Tests' }], type: 'metrics' }));
    expect(output).toBe('```atelier-widget\n{"items":[{"label":"Tests","value":"42"}],"type":"metrics"}\n```\n');
    expect(widgetSpecs(output)).toEqual([{ type: 'metrics', items: [{ label: 'Tests', value: '42' }] }]);
  });

  it.each([
    ['', 'empty'],
    ['{', 'not valid JSON'],
    [JSON.stringify({ type: 'metrics', items: [{ label: 'Tests', value: '42', surprise: true }] }), 'unknown fields'],
    [JSON.stringify({ type: 'progress', items: [{ label: 'Tests', value: 'many' }] }), 'contract'],
  ])('refuses malformed input without returning a near-valid block', (source, message) => {
    expect(() => present(['widget'], source)).toThrow(message);
  });
});
