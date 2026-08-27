import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { widgetSpecs } from '../../src/workbench/chat-widgets';

const instructions = [
  readFileSync('machinery/skills/atelier/SKILL.md', 'utf8'),
  readFileSync('.claude/output-styles/manager.md', 'utf8'),
];

describe('agent chat widget instructions', () => {
  it.each(instructions)('teaches both when to use widgets and when prose is better', (text) => {
    expect(text).toContain('atelier-widget');
    for (const kind of ['metrics', 'bar', 'line', 'progress', 'timeline', 'table']) expect(text).toContain(kind);
    expect(text).toMatch(/do not (use|decorate)/i);
    expect(text).toMatch(/one fact|short list/i);
  });

  it('keeps every canonical skill example valid against the renderer contract', () => {
    const widgets = widgetSpecs(instructions[0]);
    expect(widgets.map((widget) => widget.type)).toEqual([
      'metrics', 'chart', 'chart', 'progress', 'timeline', 'table', 'video',
    ]);
    expect(widgets.filter((widget) => widget.type === 'chart').map((widget) => widget.chart)).toEqual(['bar', 'line']);
  });
});
