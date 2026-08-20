/**
 * Chips put into a command that has already been coloured.
 *
 * The danger here is not missing an address; it is writing into the markup. A
 * chip opened inside a `<span class="hljs-string">` is a broken tag, and a
 * command containing `&&` that comes back containing `&amp;&amp;` is a command
 * nobody can copy (bw-khe.13).
 */
import { describe, expect, it } from 'vitest';

import { chipsInHtml, escapeHtml, unescapeHtml } from '@/workbench/paths-in-html';
import { pathsIn, type OnDisk, type Rooted } from '@/workbench/paths';

const WHERE: Rooted = { cwd: '/home/someone/project', home: '/home/someone' };
const ALL: OnDisk = { real: () => true };
const NONE: OnDisk = { real: () => false };

const split = (disk: OnDisk) => (text: string) => pathsIn(text, WHERE, disk);

describe('chips in painted text', () => {
  it('wraps an address that is really there', () => {
    const out = chipsInHtml('cd /home/someone/project', split(ALL));
    expect(out).toContain('data-path-mention="/home/someone/project"');
    expect(out).toContain('>/home/someone/project</span>');
  });

  it('hands back the same string when nothing in it is a file', () => {
    const html = '<span class="hljs-built_in">cd</span> and/or';
    expect(chipsInHtml(html, split(NONE))).toBe(html);
  });

  it('never writes inside a tag', () => {
    // The class name has the shape of an address; it is markup, not writing.
    const html = '<span class="hljs-a/b.ts">cd src/lib/api.ts</span>';
    const out = chipsInHtml(html, split(ALL));
    expect(out).toContain('class="hljs-a/b.ts"');
    expect(out.match(/data-path-mention/g)).toHaveLength(1);
  });

  it('leaves the colouring around an address alone', () => {
    const html = '<span class="hljs-built_in">cd</span> /home/someone/project && ls';
    const out = chipsInHtml(html, split(ALL));
    expect(out).toContain('<span class="hljs-built_in">cd</span>');
  });

  it('gives back a command that still reads as the command', () => {
    const html = 'cd /home/someone/project &amp;&amp; grep -rn &quot;x&quot;';
    const out = chipsInHtml(html, split(ALL));
    // Strip the markup and we are back to what was run, ampersands and all.
    expect(unescapeHtml(out.replace(/<[^>]*>/g, ''))).toBe('cd /home/someone/project && grep -rn "x"');
  });

  it('carries the line when one was written', () => {
    const out = chipsInHtml('src/lib/api.ts:42', split(ALL));
    expect(out).toContain('data-path-line="42"');
    expect(out).toContain('>src/lib/api.ts:42</span>');
  });

  it('carries no line when none was', () => {
    expect(chipsInHtml('src/lib/api.ts', split(ALL))).not.toContain('data-path-line');
  });
});

describe('escaping', () => {
  it('goes there and back', () => {
    const written = `a & b < c > d " e ' f`;
    expect(unescapeHtml(escapeHtml(written))).toBe(written);
  });
});
