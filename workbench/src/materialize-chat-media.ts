import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';

import { comparisonSpecs } from '../../src/workbench/chat-media.ts';
import type { ImageComparison, ImagePayload } from '../../src/workbench/protocol.ts';

const MIMES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

function inside(root: string, path: string): boolean {
  const from = relative(root, path);
  return from === '' || (!from.startsWith('..') && !isAbsolute(from));
}

function generatedCodexImage(path: string): boolean {
  return dirname(dirname(path)) === realpathSync(tmpdir())
    && basename(dirname(path)).startsWith('atelier-codex-images-');
}

function picture(cwd: string, named: { path: string; caption?: string }, fallback: string): ImagePayload | null {
  try {
    const root = realpathSync(cwd);
    const path = realpathSync(resolve(root, named.path));
    // Codex places images attached to a chat in a private, per-turn temp
    // directory. Those are legitimate comparison inputs even though they sit
    // outside the repository; every other outside path remains forbidden.
    if (!inside(root, path) && !generatedCodexImage(path)) return null;
    const mime = MIMES[extname(path).toLowerCase()];
    if (!mime) return null;
    return { mime, dataUrl: `data:${mime};base64,${readFileSync(path).toString('base64')}`, alt: named.caption || fallback };
  } catch {
    return null;
  }
}

export function materializeComparisons(text: string, cwd: string): ImageComparison[] {
  return comparisonSpecs(text).flatMap((spec) => {
    const before = picture(cwd, spec.before, 'Before');
    const after = picture(cwd, spec.after, 'After');
    return before && after ? [{ mode: spec.mode, before, after }] : [];
  });
}
