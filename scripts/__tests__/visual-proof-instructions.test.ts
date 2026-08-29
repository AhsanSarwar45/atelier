import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const policy = readFileSync('machinery/skills/atelier/SKILL.md', 'utf8');
const claudeStyle = readFileSync('.claude/output-styles/manager.md', 'utf8');

describe('visual proof instructions', () => {
  it.each([
    ['shared provider policy', policy],
    ['Claude manager style', claudeStyle],
  ])('%s requires comparisons for changes and an image for new visuals', (_name, instructions) => {
    expect(instructions).toMatch(/every visual change/i);
    expect(instructions).toMatch(/before editing/i);
    expect(instructions).toMatch(/again\s+after(?:ward)?/i);
    expect(instructions).toMatch(/presenter/i);
    expect(instructions).toMatch(/newly added visual/i);
    expect(instructions).toMatch(/import and show|present image/i);
    expect(instructions).toMatch(/do not wait for the manager to ask/i);
  });

  it('uses the validated durable image commands for visual proof', () => {
    expect(policy).toContain('atelier tool present image');
    expect(policy).toContain('atelier tool present compare');
    expect(policy).toMatch(/content-addressed storage/i);
    expect(policy).toMatch(/remains available after reload/i);
  });
});
