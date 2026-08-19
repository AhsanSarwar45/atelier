/**
 * Which language a chat's code is drawn in, and what painting it produces.
 *
 * A command and a file the agent read were one flat grey block, which is what
 * the manager asked to be coloured (bw-4wcd.2).
 */
import { describe, expect, it } from 'vitest';

import { languageOf, languagesOf, paint, paintLines } from '@/workbench/colouring';

describe('the language a file is in', () => {
  it('reads it off the ending', () => {
    expect(languageOf('/w/src/app.tsx')).toBe('typescript');
    expect(languageOf('/w/main.rs')).toBe('rust');
    expect(languageOf('/w/deploy.sh')).toBe('bash');
    expect(languageOf('/w/config.toml')).toBe('ini');
  });

  it('reads a file whose whole name is the answer', () => {
    expect(languageOf('/w/Makefile')).toBe('makefile');
    expect(languageOf('/w/Dockerfile')).toBe('bash');
  });

  it('takes the last segment, never a folder that looks like a file', () => {
    expect(languageOf('/w/src.rs/notes')).toBeNull();
    expect(languageOf('/w/src.rs/main.py')).toBe('python');
  });

  it('reads a dotfile as the name the dot hides', () => {
    expect(languageOf('/home/me/.bashrc')).toBe('bash');
    expect(languageOf('/home/me/.zshrc')).toBe('bash');
    expect(languageOf('/w/.npmrc')).toBe('ini');
    expect(languageOf('/w/.eslintrc')).toBe('json');
    expect(languageOf('/w/.eslintrc.json')).toBe('json');
  });

  it('keeps a known name that carries a suffix', () => {
    expect(languageOf('/w/Dockerfile.dev')).toBe('bash');
  });

  it('says nothing for an ending nothing here knows', () => {
    expect(languageOf('/w/photo.png')).toBeNull();
    expect(languageOf('')).toBeNull();
    expect(languageOf('/w/.')).toBeNull();
  });
});

describe('painting a file that is drawn a line at a time', () => {
  const block = '/**\n * const nope = 1;\n */\nconst yes = 2;';

  it('hands back exactly one piece per line', () => {
    expect(paintLines(block, 'typescript')).toHaveLength(4);
    expect(paintLines('a\n\nb', 'typescript')).toHaveLength(3);
  });

  it('keeps a comment that spans lines a comment on every line of it', () => {
    const lines = paintLines(block, 'typescript')!;
    expect(lines[1]).toContain('hljs-comment');
    // The same line painted by itself reads as ordinary code, which is exactly
    // the mis-colouring this replaced (bw-4wcd.16).
    expect(paint(' * const nope = 1;', 'typescript')).toContain('hljs-keyword');
  });

  it('closes every tag it opens, so a line can stand in its own cell', () => {
    for (const line of paintLines(block, 'typescript')!) {
      const opened = (line.match(/<span/g) ?? []).length;
      const closed = (line.match(/<\/span>/g) ?? []).length;
      expect(opened).toBe(closed);
    }
  });

  it('still escapes what it does not colour', () => {
    const lines = paintLines('const a = 1;\nconst b = "<img src=x>";', 'typescript')!;
    expect(lines[1]).not.toContain('<img');
    expect(lines[1]).toContain('&lt;img');
  });

  it('draws it plain rather than half-painted when the language is unknown', () => {
    expect(paintLines('anything', null)).toBeNull();
    expect(paintLines('', 'typescript')).toBeNull();
  });

  it('carries the text through unchanged when the tags are taken back out', () => {
    const text = 'const a = `x\n  y`;\nconst b = 2;';
    const plain = paintLines(text, 'typescript')!
      .map((l) => l.replace(/<[^>]*>/g, ''))
      .join('\n')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&');
    expect(plain).toBe(text);
  });
});

describe('painting', () => {
  it('colours what it knows', () => {
    const html = paint('const a = 1;', 'typescript');
    expect(html).toContain('hljs-keyword');
  });

  it('escapes what it does not colour, so the page cannot be written into', () => {
    const html = paint('const a = "<img src=x onerror=alert(1)>";', 'typescript')!;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('draws it plain rather than half-painted when the language is unknown', () => {
    expect(paint('anything', null)).toBeNull();
    expect(paint('anything', 'klingon')).toBeNull();
    expect(paint('', 'typescript')).toBeNull();
  });
});

describe('which body of a row is code', () => {
  it('paints a shell command as shell, and its output as nothing', () => {
    expect(languagesOf('Bash', { command: 'ls -la' })).toEqual({ asked: 'bash', printed: null });
  });

  it('paints what a read printed, because that is the file itself', () => {
    expect(languagesOf('Read', { file_path: '/w/a.py' })).toEqual({ asked: null, printed: 'python' });
  });

  it('paints what a write was asked, because that is the file itself', () => {
    expect(languagesOf('Write', { file_path: '/w/a.go' })).toEqual({ asked: 'go', printed: null });
  });

  it('leaves a call about no file alone', () => {
    expect(languagesOf('WebFetch', { url: 'https://example.com' })).toEqual({ asked: null, printed: null });
  });
});
