/** @vitest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface PackageScripts {
  scripts: Record<string, string>;
}

const project = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8')) as PackageScripts;

describe('the native development server', () => {
  it('starts the Rust server without selecting a helper runtime', () => {
    expect(pkg.scripts['server:dev']).toBe('cd server && cargo run');
    expect(pkg.scripts['server:dev']).not.toContain('BEADS_WORKBENCH_ENTRY');
  });

  it('is also selected by the combined frontend/backend launcher', () => {
    expect(pkg.scripts['dev:full']).toContain('npm run server:dev');
  });

  it('keeps the static frontend preview command separate', () => {
    expect(pkg.scripts.start).toBe('next start -p 3007');
  });
});
