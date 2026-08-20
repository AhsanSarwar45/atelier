/**
 * There is no second control over the machine's own lines.
 *
 * A chat used to hold quiet lines back unless a "Show everything" button was
 * on, and the kind filter counted only what that button let through — so a
 * conversation carrying thirty-three status lines reported none, and the
 * manager was told to press a button he did not want to exist (bw-jkh2.13).
 * The kind filter is the whole of it now.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Every file of the app's own source, so nothing hides in a corner of it. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('the control that opened everything', () => {
  const files = sources('src').filter((path) => !path.includes('__tests__'));

  it('is not remembered anywhere', () => {
    const holding = files.filter((path) => readFileSync(path, 'utf8').includes('open-all'));
    expect(holding).toEqual([]);
  });

  it('is not offered anywhere', () => {
    const offering = files.filter((path) => /Show everything|Show less/.test(readFileSync(path, 'utf8')));
    expect(offering).toEqual([]);
  });
});
