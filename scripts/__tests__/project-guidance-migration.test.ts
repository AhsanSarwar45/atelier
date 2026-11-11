import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('this project uses Atelier guidance', () => {
  it('keeps the isolation policy in project instructions', () => {
    const instructions = readFileSync('.atelier/instructions.md', 'utf8');
    expect(instructions.match(/## Isolated app instances/g)).toHaveLength(1);
    expect(instructions).toContain("Never touch the owner's");
    expect(instructions).toContain('app, backend, helper, data, or port 3008.');
    expect(instructions).toContain('Cleanup only recorded child PIDs');
  });

  it('retires duplicate provider guidance without removing enforcement configuration', () => {
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      expect(existsSync(path), path).toBe(false);
    }
    for (const path of ['.claude/settings.json', '.codex/config.toml']) {
      expect(existsSync(path), path).toBe(true);
    }
  });
});
