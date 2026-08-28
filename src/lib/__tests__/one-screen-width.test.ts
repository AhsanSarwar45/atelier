import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { NOT_PHONE_SCREEN, PHONE_SCREEN } from '@/lib/screen-width';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('one screen width', () => {
  it('uses the styling system phone boundary everywhere', () => {
    expect(PHONE_SCREEN).toBe('(max-width: 639px)');
    expect(NOT_PHONE_SCREEN).toBe('(min-width: 640px)');

    const root = join(process.cwd(), 'src');
    const offenders = sourceFiles(root)
      .filter((path) => !path.endsWith('screen-width.ts') && !path.endsWith('one-screen-width.test.ts'))
      .filter((path) => /matchMedia\(['"]\((?:min|max)-width:/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path));

    expect(offenders).toEqual([]);
  });
});
