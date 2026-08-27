import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('video proof guidance', () => {
  it.each(['AGENTS.md', 'CLAUDE.md', 'machinery/workflow-policy.md'])('%s requires the inline video widget', (file) => {
    const guidance = readFileSync(file, 'utf8');
    expect(guidance).toContain('`video` whenever showing video proof');
    expect(guidance).toContain('Never present\nvideo as a file link.');
    expect(guidance).toContain('`video`: absolute local or HTTP(S) `src`');
  });
});
