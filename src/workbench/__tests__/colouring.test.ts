/**
 * Which language a chat's code is drawn in, and what painting it produces.
 *
 * A command and a file the agent read were one flat grey block, which is what
 * the manager asked to be coloured (bw-4wcd.2).
 */
import { describe, expect, it } from 'vitest';

import { languageOf, languagesOf, paint } from '@/workbench/colouring';

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

  it('says nothing for an ending nothing here knows', () => {
    expect(languageOf('/w/photo.png')).toBeNull();
    expect(languageOf('')).toBeNull();
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
