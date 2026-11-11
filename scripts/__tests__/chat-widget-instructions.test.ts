import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { presentableWidget } from '../../src/workbench/chat-widgets';

const instructions = [readFileSync('machinery/skills/atelier/SKILL.md', 'utf8')];
// Schemas and examples are read on demand, not carried by every session.
const reference = readFileSync('machinery/skills/atelier-reference/SKILL.md', 'utf8');

describe('agent chat widget instructions', () => {
  it.each(instructions)('teaches both when to use widgets and when prose is better', (text) => {
    expect(text).toContain('atelier-widget');
    for (const kind of ['metrics', 'bar', 'line', 'progress', 'timeline', 'table', 'explainer']) expect(text).toContain(kind);
    expect(text).toMatch(/do not (use|decorate)/i);
    expect(text).toMatch(/one fact|short list/i);
  });

  it.each(instructions)('requires the validated presenter instead of hand-authored syntax', (text) => {
    expect(text).toContain('Atelier presenter');
    // The chat draws what the presenter printed; a paste was the step agents
    // skipped (bw-yh4nu).
    expect(text).toMatch(/do not copy its stdout/i);
    expect(text).toMatch(/never hand-author/i);
  });

  it('keeps every canonical JSON input valid against the presenter contract', () => {
    const widgets = [...reference.matchAll(/```json\n([^\n]+)\n```/g)].map((match) => presentableWidget(JSON.parse(match[1]!)));
    expect(widgets.every(Boolean)).toBe(true);
    expect(widgets.map((widget) => widget?.type)).toEqual(['metrics', 'chart', 'progress', 'timeline', 'table', 'explainer']);
  });

  it('teaches every animated layout and automatic semantic color', () => {
    for (const layout of ['flow', 'sequence', 'cycle', 'layers']) expect(reference).toContain(`\`${layout}\``);
    expect(reference).toMatch(/semantic accent colors automatically/i);
  });

  it('keeps how to save a memory where the short text sends agents', () => {
    for (const want of ['atelier tool memory add', '--scope', 'One fact per memory']) expect(reference).toContain(want);
  });

  it('keeps checklists out of the skill every session gets', () => {
    for (const text of [instructions[0], reference]) {
      expect(text).not.toMatch(/checklist/i);
    }
  });
});


describe('question-based visual recipes', () => {
  const guide = readFileSync('machinery/skills/atelier-reference/references/choosing-visuals.md', 'utf8');
  it('offers only presenter-valid worked examples', () => {
    const recipes = [...guide.matchAll(/```json\n([^\n]+)\n```/g)];
    expect(recipes.length).toBeGreaterThanOrEqual(3);
    for (const recipe of recipes) expect(presentableWidget(JSON.parse(recipe[1]!))).not.toBeNull();
  });
});
