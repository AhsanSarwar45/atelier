import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('this project uses Atelier guidance', () => {
  it('keeps the isolation policy in project instructions, and nothing of the retired board', () => {
    const instructions = readFileSync('.atelier/instructions.md', 'utf8');
    expect(instructions).not.toMatch(/board lifecycle|\bbd\b|Beads/);
    expect(instructions.match(/## Isolated app instances/g)).toHaveLength(1);
    expect(instructions).toContain("Never touch the owner's");
    expect(instructions).toContain('app, backend, helper, data, or port 3008.');
    expect(instructions).toContain('Cleanup only recorded child PIDs');
  });

  it('carries no Beads project skill', () => {
    expect(existsSync('.atelier/skills/beads'), '.atelier/skills/beads').toBe(false);
  });

  it('retires duplicate provider guidance without removing enforcement configuration', () => {
    for (const path of ['AGENTS.md', 'CLAUDE.md', '.agents/skills/beads/SKILL.md', '.agents/skills/beads/agents/openai.yaml']) {
      expect(existsSync(path), path).toBe(false);
    }
    for (const path of ['.claude/settings.json', '.codex/config.toml', '.codex/hooks.json']) {
      expect(existsSync(path), path).toBe(true);
    }
  });
});
