import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/workbench/protocol';

// A phone opens the app over plain HTTP on the same network, where
// `crypto.randomUUID` does not exist. Calling it there throws, and the button
// that called it does nothing: sending a message on Firefox mobile did exactly
// that (bw-fe8vm), as attaching a picture did before (bw-8ig7).
describe('naming things on a plain-HTTP page', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes a v4 UUID without crypto.randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    expect((globalThis.crypto as Crypto).randomUUID).toBeUndefined();
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newId()).not.toBe(id);
  });

  it('is never left to crypto.randomUUID anywhere in the browser code', () => {
    const root = join(__dirname, '..', '..');
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(path);
        } else if (/\.(ts|tsx)$/.test(name) && /crypto\.randomUUID\s*\(/.test(readFileSync(path, 'utf8'))) {
          callers.push(path.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(callers).toEqual([]);
  });
});
