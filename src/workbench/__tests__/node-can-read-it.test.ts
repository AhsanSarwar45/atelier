/**
 * The files the chat's own server reads are read by Node, not by a bundler
 * (bw-7ks.22.35).
 *
 * The sidecar is `node --experimental-strip-types` over this very TypeScript:
 * no build step, no resolver of its own. Node resolves the exact filename or
 * nothing. The browser's build resolves either spelling, so a bare `./protocol`
 * is green in the typecheck, green in the whole unit suite, green in the
 * production build — and kills the sidecar on launch, which restarts it, which
 * kills it again, and no chat in the app opens at all.
 *
 * Type-only imports are erased before Node ever sees them, so those are free to
 * be spelled the short way and are not asked about here.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

/** Where the shared files live: the sidecar reaches into this directory. */
const SHARED = join(__dirname, '..');

/** Every relative import that survives to runtime, with the line it is on. */
function runtimeImports(source: string): { spec: string; line: number }[] {
  // `import type` and `export type` are erased before Node sees them, and one
  // of them can run down a dozen lines. Blanked rather than deleted, so what is
  // left is still on the line it was written on.
  const live = source.replace(/(^|\n)\s*(import|export)\s+type\b[\s\S]*?from\s+'[^']*';/g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );

  const found: { spec: string; line: number }[] = [];
  live.split('\n').forEach((text, i) => {
    const from = /\bfrom\s+'(\.[^']*)'/.exec(text);
    if (from) found.push({ spec: from[1]!, line: i + 1 });
  });
  return found;
}

describe('what the chat’s own server can read', () => {
  it('names the file, extension and all, on every runtime import it could reach', () => {
    // Only the plain .ts files: a .tsx is a component and the sidecar never
    // loads one.
    const shared = readdirSync(SHARED).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
    expect(shared.length).toBeGreaterThan(0);

    const bare: string[] = [];
    for (const file of shared) {
      for (const { spec, line } of runtimeImports(readFileSync(join(SHARED, file), 'utf8'))) {
        if (!/\.(ts|json)$/.test(spec)) bare.push(`${file}:${line} imports '${spec}'`);
      }
    }

    expect(bare, 'Node resolves the exact filename or nothing').toEqual([]);
  });
});
