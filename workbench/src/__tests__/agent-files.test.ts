import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { discoverAgentFiles, readAgentFile } from '../agent-files.ts';

function file(path: string, content = 'hello') { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); }

describe('provider-neutral agent file discovery', () => {
  it('discovers documented Claude and Codex personal and project locations', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-home-'));
    const project = mkdtempSync(join(tmpdir(), 'agent-project-'));
    file(join(home, '.claude', 'CLAUDE.md'));
    file(join(home, '.claude', 'commands', 'old.md'));
    file(join(home, '.agents', 'skills', 'shared', 'SKILL.md'));
    file(join(home, '.codex', 'config.toml'));
    file(join(project, 'AGENTS.md'));
    file(join(project, 'packages', 'api', 'AGENTS.override.md'));
    file(join(project, '.claude', 'settings.local.json'));
    file(join(project, '.codex', 'agents', 'reviewer.toml'));
    const files = discoverAgentFiles(project, home);
    expect(files.map((row) => [row.provider, row.scope, row.category, row.name])).toEqual(expect.arrayContaining([
      ['claude', 'personal', 'instructions', 'CLAUDE.md'],
      ['claude', 'personal', 'commands', 'old.md'],
      ['codex', 'personal', 'skills', 'SKILL.md'],
      ['codex', 'project', 'instructions', 'AGENTS.override.md'],
      ['claude', 'project-local', 'settings', 'settings.local.json'],
      ['codex', 'project', 'agents', 'reviewer.toml'],
    ]));
    expect(files.find((row) => row.name === 'old.md')?.legacy).toBe(true);
  });

  it('reads only a file included by a provider manifest', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-read-home-'));
    const project = mkdtempSync(join(tmpdir(), 'agent-read-project-'));
    const settings = join(project, '.codex', 'config.toml');
    file(settings, 'model = "gpt"\n');
    process.env.CODEX_HOME = join(home, '.codex');
    expect(readAgentFile(settings, project)).toEqual({ content: 'model = "gpt"\n', truncated: false });
    expect(() => readAgentFile(join(project, 'package.json'), project)).toThrow('not part');
    delete process.env.CODEX_HOME;
  });

  it('reports a symlink target without escaping discovery through arbitrary paths', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-link-home-'));
    const target = join(home, 'instructions.md');
    file(target);
    mkdirSync(join(home, '.claude'), { recursive: true });
    symlinkSync(target, join(home, '.claude', 'CLAUDE.md'));
    expect(discoverAgentFiles(undefined, home)[0]?.symlinkTarget).toBe(target);
  });
});
