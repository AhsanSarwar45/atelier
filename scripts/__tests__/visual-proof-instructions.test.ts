import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const policy = readFileSync('ATELIER_WORKFLOW.md', 'utf8');
const claudeStyle = readFileSync('.claude/output-styles/manager.md', 'utf8');

describe('visual proof instructions', () => {
  it.each([
    ['shared provider policy', policy],
    ['Claude manager style', claudeStyle],
  ])('%s requires comparisons for changes and an image for new visuals', (_name, instructions) => {
    expect(instructions).toMatch(/every visual change/i);
    expect(instructions).toMatch(/before editing/i);
    expect(instructions).toMatch(/again\s+after(?:ward)?/i);
    expect(instructions).toContain('atelier-image-compare');
    expect(instructions).toMatch(/newly added visual/i);
    expect(instructions).toMatch(/ordinary inline\s+image/i);
    expect(instructions).toMatch(/do not wait for the manager to ask/i);
  });
});
