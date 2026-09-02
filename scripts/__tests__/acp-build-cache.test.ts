import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const BUILDER = resolve(process.cwd(), 'scripts', 'build-acp-adapters.mjs');
const TARGET = 'x86_64-unknown-linux-gnu';
const FILES = [
  'claude-acp',
  'codex-acp',
  'goose-acp',
  'claude-provider',
  'codex-provider',
  'codex-code-mode-host',
];
let roots: string[] = [];

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function completeBundle(root: string, fingerprint = sha256(BUILDER)): string {
  const output = join(root, 'bundle');
  mkdirSync(output, { recursive: true });
  for (const file of FILES) writeFileSync(join(output, file), `complete ${file}\n`);
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify({
    schema: 2,
    target: TARGET,
    builderFingerprint: fingerprint,
    files: Object.fromEntries(FILES.map(file => [file, { sha256: sha256(join(output, file)) }])),
  })}\n`);
  return output;
}

function run(output: string, mode: '--cache-only' | '--cache-info', cache?: string) {
  const result = spawnSync(process.execPath, [BUILDER, TARGET, output, mode], {
    encoding: 'utf8',
    env: { ...process.env, ...(cache ? { ATELIER_ACP_BUILD_CACHE: cache } : {}) },
  });
  if (result.error) throw result.error;
  return result;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('the local ACP build cache', () => {
  it('reuses a complete bundle only while every executable and builder input matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'atelier-acp-cache-test-'));
    roots.push(root);
    const output = completeBundle(root);

    const hit = run(output, '--cache-only');
    expect(hit.status, hit.stderr).toBe(0);
    expect(hit.stdout).toContain('ACP adapter bundle is current');

    writeFileSync(join(output, 'goose-acp'), 'tampered\n');
    const changedFile = run(output, '--cache-only');
    expect(changedFile.status).toBe(3);
    expect(changedFile.stderr).toContain('cache miss');

    const stale = completeBundle(root, 'old-builder');
    const changedBuilder = run(stale, '--cache-only');
    expect(changedBuilder.status).toBe(3);
  });

  it('keeps Goose Cargo artifacts outside disposable sources and keys them by target and revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'atelier-acp-cache-test-'));
    roots.push(root);
    const cache = join(root, 'persistent');
    const first = run(join(root, 'one'), '--cache-info', cache);
    const second = run(join(root, 'two'), '--cache-info', cache);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    const a = JSON.parse(first.stdout) as { gooseTarget: string; target: string };
    const b = JSON.parse(second.stdout) as { gooseTarget: string; target: string };
    expect(a.gooseTarget).toBe(b.gooseTarget);
    expect(a.gooseTarget).toContain(cache);
    expect(a.gooseTarget).toContain(TARGET);
    expect(a.gooseTarget).toMatch(/[0-9a-f]{40}$/);
  });
});
