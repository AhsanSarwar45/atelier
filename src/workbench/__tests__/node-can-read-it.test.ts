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
import { dirname, join, resolve } from 'path';

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


/** Where the sidecar's own files live — the entry points of the walk. */
const SERVER = join(__dirname, '..', '..', '..', 'workbench', 'src');

/**
 * Every file the chat's own server can load, followed from its own directory
 * through the relative imports that survive to runtime.
 */
function reachedFromTheServer(): string[] {
  const seen = new Set<string>();
  const queue = readdirSync(SERVER)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(SERVER, f));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const { spec } of runtimeImports(source)) {
      const next = resolve(dirname(file), spec);
      if (next.endsWith('.ts')) queue.push(next);
    }
  }
  // The sidecar's own files are not under test here: this is about the shared
  // ones, which the browser build also reads and which is where the two
  // resolvers disagree.
  return Array.from(seen)
    .filter((f) => f.startsWith(SHARED + '/'))
    .sort();
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

  /**
   * And the same fault in its other spelling.
   *
   * `@/workbench/protocol` is the browser build's alias, and Node has no
   * aliases at all: it reads the bare word as a package name, finds no such
   * package, and the sidecar dies on launch exactly as it does for a missing
   * extension — while the typecheck, the unit suite and the production build
   * all stay green (bw-jaoz.5, found by the browser check).
   *
   * Only the files the sidecar can actually reach are asked. Half of this
   * directory is browser code — a hook, a store, a screen's helper — which the
   * sidecar never loads and which is right to use the alias.
   */
  it('never reaches the browser build’s alias from anything the server loads', () => {
    const bad: string[] = [];
    for (const file of reachedFromTheServer()) {
      const source = readFileSync(file, 'utf8');
      const live = source.replace(/(^|\n)\s*(import|export)\s+type\b[\s\S]*?from\s+'[^']*';/g, (m) =>
        m.replace(/[^\n]/g, ' '),
      );
      live.split('\n').forEach((text, i) => {
        if (/\bfrom\s+'@\//.test(text)) bad.push(`${file.slice(file.indexOf('/src/'))}:${i + 1}`);
      });
    }
    expect(bad, 'Node has no aliases: the sidecar dies on launch').toEqual([]);
  });
});
