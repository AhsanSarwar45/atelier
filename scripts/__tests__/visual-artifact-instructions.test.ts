import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { visualArtifact } from '../../src/workbench/visual-artifacts';

const skill = readFileSync('machinery/skills/atelier/SKILL.md', 'utf8');
const reference = readFileSync('machinery/skills/atelier/references/visual-artifacts.md', 'utf8');
const claude = readFileSync('.claude/output-styles/manager.md', 'utf8');

describe('visual artifact agent guidance', () => {
  it.each([skill, claude])('routes agents among every rich visual mode', (text) => {
    for (const term of ['Mermaid', 'React Flow', 'Motion', 'mockup', 'full-screen']) expect(text).toContain(term);
  });
  it('explains the decision boundary and provider-neutral presenter path', () => {
    for (const kind of ['`mermaid`', '`flow`', '`scene`', '`mockup`']) expect(skill).toContain(kind);
    expect(skill).toContain('atelier tool present artifact --file FILE');
    expect(skill).toMatch(/Codex, Claude, and other\s+shell-capable agents/i);
    expect(skill).toMatch(/cannot contain JavaScript, HTML/i);
  });
  it('keeps every reference example valid against the actual contract', () => {
    const examples = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!));
    expect(examples).toHaveLength(4);
    expect(examples.map((example) => visualArtifact(example)?.kind)).toEqual(['mermaid', 'flow', 'scene', 'mockup']);
  });
});
