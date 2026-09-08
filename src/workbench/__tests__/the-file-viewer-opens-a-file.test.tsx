/**
 * What the file viewer puts on screen when it is handed a file.
 *
 * The editor underneath is CodeMirror, which owns its own DOM and builds it
 * outside React, so these ask the document rather than the component: is there
 * a gutter with numbers in it, did the grammar arrive and colour anything, is
 * the line the address named wearing the mark, and does a file too big to parse
 * come up as plain text instead (bw-g3o3.17).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { THEMES } from '@/lib/themes';
import { HIGHLIGHTED_LINE_CLASS } from '@/workbench/code-theme';
import { FileViewer, PLAIN_ABOVE_LINES, humaneSize, relativeToRoot, tooLargeToParse } from '@/workbench/file-viewer';

vi.mock('@/lib/api', () => ({ fs: { openExternal: vi.fn().mockResolvedValue(undefined) } }));

const ROOT = '/home/reader/project';

const SOURCE = [
  "import { useState } from 'react';",
  '',
  '// A counter, so the grammar has a keyword, a string and a comment to find.',
  'export function Counter() {',
  '  const [count, setCount] = useState(0);',
  "  return <button onClick={() => setCount(count + 1)}>{'clicked '}{count}</button>;",
  '}',
].join('\n');

const textFile = (text: string) => ({ kind: 'text' as const, text, size: text.length });

describe('the file viewer', () => {
  it('opens a file in CodeMirror with a numbered gutter', async () => {
    const { container } = render(
      <FileViewer root={ROOT} path={`${ROOT}/src/counter.tsx`} file={textFile(SOURCE)} />,
    );

    await waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull());
    expect(container.querySelector('.cm-content')?.textContent).toContain('useState');
    const numbers = [...container.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].map((el) => el.textContent);
    expect(numbers).toContain('1');
    expect(numbers).toContain('7');
  });

  it('says where the file is and how big it is', () => {
    const { getByTestId } = render(
      <FileViewer root={ROOT} path={`${ROOT}/src/counter.tsx`} file={textFile(SOURCE)} />,
    );
    expect(getByTestId('file-viewer-breadcrumb').textContent).toContain('counter.tsx');
    expect(getByTestId('file-viewer-breadcrumb').textContent).toContain('src');
    expect(getByTestId('file-viewer-size').textContent).toBe(humaneSize(SOURCE.length));
  });

  it('fetches the grammar the path names and colours the code with it', async () => {
    const { container } = render(
      <FileViewer root={ROOT} path={`${ROOT}/src/counter.tsx`} file={textFile(SOURCE)} />,
    );
    // Nothing is coloured until the language chunk lands, which is a promise
    // later than the mount; when it does, lezer wraps each token in a span
    // wearing one of the highlight style's generated classes.
    const painted = () =>
      [...container.querySelectorAll('.cm-content span[class]')]
        .filter((span) => span.className.startsWith('ͼ'))
        .map((span) => span.textContent);
    await waitFor(() => expect(painted()).toContain('import'), { timeout: 10_000 });
    expect(painted()).toContain("'react'");
  });

  it('leaves the file read-only until a later card asks otherwise', async () => {
    const { container } = render(
      <FileViewer root={ROOT} path={`${ROOT}/src/counter.tsx`} file={textFile(SOURCE)} />,
    );
    await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull());
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).not.toBe('true');
  });

  it('marks the line the address named', async () => {
    const { container } = render(
      <FileViewer root={ROOT} path={`${ROOT}/src/counter.tsx`} line={4} file={textFile(SOURCE)} />,
    );
    await waitFor(() => expect(container.querySelector(`.${HIGHLIGHTED_LINE_CLASS}`)).not.toBeNull());
    expect(container.querySelector(`.${HIGHLIGHTED_LINE_CLASS}`)?.textContent).toContain('export function Counter()');
  });

  it('opens a file too long to parse as plain text instead', () => {
    const long = `${'const line = 1;\n'.repeat(PLAIN_ABOVE_LINES + 1)}`;
    const { getByTestId, queryByTestId } = render(
      <FileViewer root={ROOT} path={`${ROOT}/src/generated.ts`} file={textFile(long)} />,
    );
    expect(getByTestId('file-viewer-plain').textContent).toContain('const line = 1;');
    expect(queryByTestId('file-viewer')).toBeNull();
  });

  it('trips the guard on size as well as on line count', () => {
    expect(tooLargeToParse(3 * 1024 * 1024, 'one line')).toBe(true);
    expect(tooLargeToParse(200, 'one line')).toBe(false);
    expect(tooLargeToParse(200, 'x\n'.repeat(PLAIN_ABOVE_LINES + 1))).toBe(true);
  });

  it('says so rather than drawing a binary file', () => {
    const { getByTestId } = render(
      <FileViewer root={ROOT} path={`${ROOT}/logo.png`} file={{ kind: 'binary', size: 4096 }} />,
    );
    expect(getByTestId('file-viewer-binary').textContent).toContain('Binary file');
  });
});

describe('the file viewer header', () => {
  it('reads a path under the root as the path a reader would type', () => {
    expect(relativeToRoot(ROOT, `${ROOT}/src/counter.tsx`)).toBe('src/counter.tsx');
    expect(relativeToRoot(ROOT, '/etc/hosts')).toBe('/etc/hosts');
    expect(relativeToRoot('', '/etc/hosts')).toBe('/etc/hosts');
  });

  it('says a size the way a person does', () => {
    expect(humaneSize(512)).toBe('512 B');
    expect(humaneSize(2048)).toBe('2 KB');
    expect(humaneSize(1536)).toBe('1.5 KB');
    expect(humaneSize(20 * 1024 * 1024)).toBe('20 MB');
  });
});

/**
 * The code inks are the whole point of the theme file: eleven skins, and a
 * skin that names none of them paints code in the last skin's colours.
 */
describe('the code colours', () => {
  const source = join(__dirname, '..', '..', 'app');
  const globals = readFileSync(join(source, 'globals.css'), 'utf8');
  const themeCss = readFileSync(join(source, 'themes.css'), 'utf8');

  const declared = (css: string, selector: string) => {
    const at = css.indexOf(selector);
    if (at < 0) return new Set<string>();
    const open = css.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    const names = new Set<string>();
    const rule = /(--code-[\w-]+)\s*:/g;
    for (let m = rule.exec(css.slice(open, end)); m; m = rule.exec(css.slice(open, end))) names.add(m[1]);
    return names;
  };

  const roles = declared(globals, ':root');

  it('names an ink for every role a grammar has', () => {
    expect([...roles].sort()).toEqual(
      [
        '--code-attribute',
        '--code-comment',
        '--code-function',
        '--code-invalid',
        '--code-keyword',
        '--code-number',
        '--code-operator',
        '--code-punctuation',
        '--code-string',
        '--code-tag',
        '--code-type',
        '--code-variable',
      ],
    );
  });

  it('gives a light page its own set rather than the dark one', () => {
    expect(declared(globals, '.light')).toEqual(roles);
  });

  it('leaves no skin holding half a palette', () => {
    // A skin either names all twelve or names none and takes the block for its
    // mode. Naming some is the failure: the rest come from whichever mode block
    // is in force, and a Catppuccin keyword beside a One Dark string is a bug
    // nobody would look for.
    for (const theme of THEMES) {
      if (theme.id === 'default') continue;
      const own = declared(themeCss, `html[data-theme="${theme.id}"]`);
      if (own.size > 0) expect({ id: theme.id, own }).toEqual({ id: theme.id, own: roles });
    }
  });
});
