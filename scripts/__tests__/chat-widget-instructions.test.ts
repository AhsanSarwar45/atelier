import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { presentableWidget } from '../../src/workbench/chat-widgets';

const instructions = [readFileSync('machinery/skills/atelier/SKILL.md', 'utf8')];

describe('agent chat widget instructions', () => {
  it.each(instructions)('teaches both when to use widgets and when prose is better', (text) => {
    expect(text).toContain('atelier-widget');
    for (const kind of ['metrics', 'bar', 'line', 'progress', 'timeline', 'table', 'explainer']) expect(text).toContain(kind);
    expect(text).toMatch(/do not (use|decorate)/i);
    expect(text).toMatch(/one fact|short list/i);
  });

  it.each(instructions)('requires the validated presenter instead of hand-authored syntax', (text) => {
    expect(text).toContain('Atelier presenter');
    expect(text).toMatch(/copy .*stdout/i);
    expect(text).toMatch(/never hand-author/i);
  });

  it('keeps every canonical JSON input valid against the presenter contract', () => {
    const widgets = [...instructions[0].matchAll(/```json\n([^\n]+)\n```/g)].map((match) => presentableWidget(JSON.parse(match[1]!)));
    expect(widgets.every(Boolean)).toBe(true);
    expect(widgets.map((widget) => widget?.type)).toEqual(['metrics', 'chart', 'progress', 'timeline', 'table', 'explainer']);
  });

  it('teaches every animated layout and automatic semantic color', () => {
    for (const layout of ['flow', 'sequence', 'cycle', 'layers']) expect(instructions[0]).toContain(`\`${layout}\``);
    expect(instructions[0]).toMatch(/semantic accent colors automatically/i);
  });

  it('makes the live checklist an epic-backed view instead of agent-maintained state', () => {
    expect(instructions[0]).toMatch(/checklist is a view of an epic/i);
    expect(instructions[0]).toMatch(/epic's ID as the\s+single item/i);
    expect(instructions[0]).toMatch(/reads every title and status from Beads/i);
    expect(instructions[0]).toMatch(/never[\s\S]*update .*checklist statuses by hand/i);
    expect(instructions[0]).toMatch(/standalone ticket.*do not publish a checklist/i);
  });
});
