import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { comparisonSpecs } from '../../src/workbench/chat-media';

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
    expect(instructions).toContain('atelier-image-compare');
    expect(instructions).toMatch(/newly added visual/i);
    expect(instructions).toMatch(/ordinary inline\s+image/i);
    expect(instructions).toMatch(/do not wait for the manager to ask/i);
  });

  it('gives agents a renderer-valid image comparison and its path boundary', () => {
    expect(comparisonSpecs(policy)).toContainEqual({
      mode: 'side_by_side',
      before: { path: 'shots/before.png', caption: 'Before' },
      after: { path: 'shots/after.png', caption: 'After' },
    });
    expect(policy).toContain('/tmp/atelier-codex-images-*/');
    expect(policy).toMatch(/other outside or arbitrary `\/tmp` paths are rejected/i);
  });
});
