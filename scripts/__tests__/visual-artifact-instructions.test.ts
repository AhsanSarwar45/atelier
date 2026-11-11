import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { visualArtifact } from '../../src/workbench/visual-artifacts';

// Wrapping is layout, not policy: match with whitespace collapsed.
const skill = readFileSync('machinery/skills/atelier-reference/SKILL.md', 'utf8').replace(/\s+/g, ' ');
const reference = readFileSync('machinery/skills/atelier-reference/references/visual-artifacts.md', 'utf8');

describe('visual artifact agent guidance', () => {
  it('routes agents among every rich visual mode', () => {
    const text = skill;
    for (const term of ['Mermaid', 'React Flow', 'SVG playback', 'mockup', 'full-screen']) expect(text).toContain(term);
  });
  it('explains the decision boundary and provider-neutral presenter path', () => {
    for (const kind of ['`mermaid`', '`flow`', '`scene`', '`mockup`', '`render`', '`mesh`']) expect(skill).toContain(kind);
    expect(skill).toContain('atelier tool present artifact --file FILE');
    expect(skill).toMatch(/Codex, Claude, and other\s+shell-capable agents/i);
    expect(skill).toMatch(/cannot contain JavaScript, HTML/i);
  });
  it('keeps every reference example valid against the actual contract', () => {
    const examples = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!));
    expect(examples).toHaveLength(5);
    expect(examples.map((example) => visualArtifact(example)?.kind)).toEqual(['mermaid', 'flow', 'scene', 'scene', 'mockup']);
  });
  it('ships computed examples that match the tested models', () => {
    for (const name of ['render-taa', 'render-filter']) {
      const example = JSON.parse(readFileSync(`machinery/skills/atelier-reference/references/${name}.json`, 'utf8'));
      expect(visualArtifact(example)?.kind).toBe('render');
      expect(example).toEqual(JSON.parse(readFileSync(`tests/fixtures/${name}.json`, 'utf8')));
    }
  });
  it('ships mesh examples that match the tested geometry', () => {
    for (const name of ['mesh-torus', 'mesh-folded']) {
      const example = JSON.parse(readFileSync(`machinery/skills/atelier-reference/references/${name}.json`, 'utf8'));
      expect(visualArtifact(example)?.kind).toBe('mesh');
      expect(example).toEqual(JSON.parse(readFileSync(`tests/fixtures/${name}.json`, 'utf8')));
    }
  });
  it('makes the mesh schema and limits discoverable', () => {
    const mesh = readFileSync('machinery/skills/atelier-reference/references/mesh-models.md', 'utf8');
    const selection = readFileSync('machinery/skills/atelier-reference/references/choosing-visuals.md', 'utf8');
    expect(skill).toContain('mesh-models.md');
    expect(selection).toContain('mesh-models.md');
    for (const field of ['vertices', 'meshlets', 'triangles', 'startAzimuth', 'endAzimuth']) expect(mesh).toContain(field);
    expect(mesh).toMatch(/occlusion/i);
  });

});
