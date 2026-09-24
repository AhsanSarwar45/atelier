import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('this project uses Atelier guidance', () => {
  it('keeps the lifecycle and isolation policies in project instructions', () => {
    const instructions = readFileSync('.atelier/instructions.md', 'utf8');
    expect(instructions).toContain('## Enforced board lifecycle');
    expect(instructions).toContain('provider-equivalent hooks');
    expect(instructions.match(/## Isolated app instances/g)).toHaveLength(1);
    expect(instructions).toContain("Never touch the owner's");
    expect(instructions).toContain('app, backend, helper, data, or port 3008.');
    expect(instructions).toContain('Cleanup only recorded child PIDs');
  });

  it('keeps the discoverable project skill and its supporting metadata together', () => {
    const skill = readFileSync('.atelier/skills/beads/SKILL.md', 'utf8');
    expect(skill).toMatch(/^---\nname: beads\ndescription:/);
    expect(skill).toContain('## Completion contract');
    expect(skill).toContain('atelier tool board/land CARD-ID');
    const metadata = readFileSync('.atelier/skills/beads/agents/openai.yaml', 'utf8');
    expect(metadata).toContain('display_name: "Beads"');
    expect(metadata).toContain('Use $beads');
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
