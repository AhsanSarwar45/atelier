/** @vitest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface PackageScripts {
  scripts: Record<string, string>;
}

const project = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8')) as PackageScripts;

describe('the development chat helper', () => {
  it('is selected from the active checkout by the backend launcher', () => {
    expect(pkg.scripts['server:dev']).toContain(
      'BEADS_WORKBENCH_ENTRY=../workbench/src/server.ts cargo run',
    );
  });

  it('is also selected by the combined frontend/backend launcher', () => {
    expect(pkg.scripts['dev:full']).toContain('npm run server:dev');
  });

  it('does not change the ordinary packaged server command', () => {
    expect(pkg.scripts.start).toBe('next start -p 3007');
  });
});
