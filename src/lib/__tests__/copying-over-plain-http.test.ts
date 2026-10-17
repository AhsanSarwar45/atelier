/**
 * A copy still copies on a page the browser does not count as secure.
 *
 * Opened over remote access at a plain http address, the browser takes
 * `navigator.clipboard` away, and every copy written against it alone did
 * nothing at all (bw-oo16q). The copy command carries the text there instead,
 * and a copy the browser refuses is reported rather than passed off as done.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyText } from '@/lib/clipboard';

describe('copying without the clipboard API', () => {
  let saved: PropertyDescriptor | undefined;
  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });
  afterEach(() => {
    if (saved) Object.defineProperty(navigator, 'clipboard', saved);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    vi.restoreAllMocks();
  });

  it('hands the exact text to the copy command', async () => {
    let carried = '';
    document.execCommand = vi.fn(() => {
      const event = new Event('copy', { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', {
        value: { setData: (_type: string, text: string) => { carried = text; } },
      });
      document.dispatchEvent(event);
      return true;
    });
    await expect(copyText('@src/a.ts:12-40\n  second line')).resolves.toBe(true);
    expect(carried).toBe('@src/a.ts:12-40\n  second line');
  });

  it('puts the reader’s own selection back', async () => {
    document.body.innerHTML = '<p id="mine">Selected words</p>';
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('mine')!);
    document.getSelection()!.addRange(range);
    document.execCommand = vi.fn(() => true);
    await copyText('other');
    expect(document.getSelection()!.toString()).toBe('Selected words');
  });

  it('says so when the browser refuses', async () => {
    document.execCommand = vi.fn(() => false);
    await expect(copyText('x')).resolves.toBe(false);
  });
});

describe('every copy goes through the one helper', () => {
  it('writes to navigator.clipboard nowhere else', () => {
    const root = join(__dirname, '..', '..');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === '__tests__' || name === 'node_modules') return [];
      if (statSync(path).isDirectory()) return walk(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
    // The terminal's OSC 52 write is a program's, with no click behind it, so
    // the copy command could never carry it and it keeps the API alone.
    const allowed = new Set(['lib/clipboard.ts', 'workbench/terminal-habits.ts']);
    const offenders = walk(root)
      .filter((path) => !allowed.has(relative(root, path)))
      .filter((path) => /navigator\.clipboard\??\.writeText/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path));
    expect(offenders).toEqual([]);
  });
});
