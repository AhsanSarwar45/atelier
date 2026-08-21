/**
 * `@/x` means `src/x`, for a script that runs the app's own files as they are.
 *
 * The screen check (chat-shows-what-is-yours.mjs) deliberately imports the real
 * sorting and the real driver rather than a copy, so it inherits their import
 * style — and the app writes `@/workbench/...`, an alias only the bundler and
 * the typechecker know about. Type imports vanish before node ever sees them,
 * so this stayed invisible until the sorting needed a real one (bw-iiv6).
 *
 * Registering it here rather than in the check keeps the order right: a
 * side-effect import placed first is evaluated before the imports beneath it.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith('@/')) return next(specifier, context);
    const stem = join(src, specifier.slice(2));
    const found = ['', '.ts', '.tsx', '.js'].map((e) => stem + e).find((p) => existsSync(p));
    if (!found) return next(specifier, context);
    return { url: pathToFileURL(found).href, shortCircuit: true };
  },
});
