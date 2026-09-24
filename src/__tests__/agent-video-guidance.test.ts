import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('video proof guidance', () => {
  it.each(['machinery/skills/atelier/SKILL.md'])('%s requires the inline video widget', (file) => {
    // Wrapping is layout, not policy: compare with whitespace collapsed.
    const guidance = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
    expect(guidance).toContain('`video` whenever showing video proof');
    expect(guidance).toMatch(/never present video as a file link/i);
    expect(guidance).toContain('- `video`: `{"type":"video","src":"..."}`.');
    expect(guidance).toMatch(/absolute local path or start with `http:`, `https:`/s);
  });
});
