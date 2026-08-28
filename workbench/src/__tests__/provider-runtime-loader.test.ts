import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('the production TypeScript loader', () => {
  it('can import both native provider adapters in strip-only mode', () => {
    expect(() => execFileSync(process.execPath, [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '-e',
      "Promise.all([import('./workbench/src/drivers/claude.ts'), import('./workbench/src/drivers/codex.ts')])",
    ], { cwd: process.cwd(), stdio: 'pipe' })).not.toThrow();
  });
});
