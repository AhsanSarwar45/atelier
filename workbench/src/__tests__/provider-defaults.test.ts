import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readProviderDefaults, writeProviderDefault } from '../provider-defaults.ts';

const originalClaude = process.env.CLAUDE_CONFIG_DIR;
const originalCodex = process.env.CODEX_HOME;
let scratch = '';

afterEach(() => {
  if (originalClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = originalClaude;
  if (originalCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodex;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('provider-native defaults', () => {
  it('preserves unrelated Claude settings while changing native model and effort keys', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'atelier-claude-defaults-'));
    process.env.CLAUDE_CONFIG_DIR = scratch;
    writeFileSync(join(scratch, 'settings.json'), JSON.stringify({ theme: 'dark', model: 'sonnet' }));
    await writeProviderDefault('claude', 'model', 'opus');
    await writeProviderDefault('claude', 'effort', 'high');
    expect(readProviderDefaults('claude')).toMatchObject({ model: 'opus', effort: 'high' });
    expect(JSON.parse(readFileSync(join(scratch, 'settings.json'), 'utf8')).theme).toBe('dark');
  });

  it('preserves Codex tables and changes only native top-level defaults', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'atelier-codex-defaults-'));
    process.env.CODEX_HOME = scratch;
    writeFileSync(join(scratch, 'config.toml'), 'model = "old"\n[projects."/work"]\ntrust_level = "trusted"\n');
    await writeProviderDefault('codex', 'model', 'gpt-5.6');
    await writeProviderDefault('codex', 'effort', 'high');
    expect(readProviderDefaults('codex')).toMatchObject({ model: 'gpt-5.6', effort: 'high' });
    expect(readFileSync(join(scratch, 'config.toml'), 'utf8')).toContain('[projects."/work"]\ntrust_level = "trusted"');
  });
});
