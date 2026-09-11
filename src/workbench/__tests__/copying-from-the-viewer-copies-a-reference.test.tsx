/**
 * Copying out of the file viewer copies a reference, and the code is still one
 * click away (bw-g3o3.10).
 *
 * Three things are proved here, and the fourth — a real Selection answered by a
 * real Ctrl-C, which is a browser's own behaviour being taken over — is proved
 * in a browser instead (tests/e2e/copying-from-the-viewer-copies-a-reference).
 *
 * The seam this leans on is `copiedSelection`: the one place that turns a range
 * of the document into the lines a reader would say they selected. It takes an
 * `EditorState` and no DOM, so what the clipboard filter would answer with can
 * be asked without a screen at all.
 */
import { EditorState } from '@codemirror/state';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** What is on the fake disk, one level per directory, as the server answers. */
const disk = new Map<string, FsTreeEntry[]>();

function blankStatus(): GitStatus {
  return {
    branch: 'main',
    upstream: null,
    pushTo: null,
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
}

vi.mock('@/lib/api', async (real) => {
  const actual = await real<typeof import('@/lib/api')>();
  return {
    ...actual,
    fs: {
      ...actual.fs,
      tree: async (dir: string) => ({ dir, entries: disk.get(dir) ?? [] }),
      watch: () => () => {},
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
    git: { ...actual.git, status: async () => blankStatus(), watch: () => () => {} },
  };
});

// eslint-disable-next-line import/first
import type { FsTreeEntry, GitStatus } from '@/lib/api';
// eslint-disable-next-line import/first
import { copiedSelection } from '@/workbench/code-editor';
// eslint-disable-next-line import/first
import FileTree from '@/workbench/file-tree';
// eslint-disable-next-line import/first
import { FileViewer } from '@/workbench/file-viewer';
// eslint-disable-next-line import/first
import { referenceUnder } from '@/workbench/references';

const ROOT = '/home/reader/project';

/** Ten numbered lines, so a line's number can be read off its text. */
const SOURCE = `${Array.from({ length: 10 }, (_, at) => `const line${at + 1} = ${at + 1};`).join('\n')}\n`;

/** What the reader's clipboard was last handed. */
let clipboard = '';

beforeAll(() => {
  // The tree is virtualised, and a virtualiser told its viewport is nought
  // high draws no rows at all; jsdom has no layout to tell it otherwise.
  for (const [side, size] of [
    ['offsetHeight', 600],
    ['clientHeight', 600],
    ['offsetWidth', 320],
    ['clientWidth', 320],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, side, { configurable: true, get: () => size });
  }
  HTMLElement.prototype.scrollTo = () => {};
});

beforeEach(() => {
  clipboard = '';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clipboard = text;
        return Promise.resolve();
      },
    },
  });
  disk.clear();
  disk.set(ROOT, [
    { name: 'src', path: `${ROOT}/src`, kind: 'dir', size: 0, mtime: 0, ignored: false, hidden: false },
    { name: 'x.ts', path: `${ROOT}/x.ts`, kind: 'file', size: 12, mtime: 0, ignored: false, hidden: false },
  ]);
});

/** The state the viewer would be holding for this file. */
const stateOf = (text: string) => EditorState.create({ doc: text });

/** Where line `n` begins and where it ends, as document positions. */
function span(state: EditorState, from: number, to: number): { from: number; to: number } {
  return { from: state.doc.line(from).from, to: state.doc.line(to).to };
}

describe('a selection in the viewer copies a reference', () => {
  it('answers lines 4 to 7 of a file with @src/x.ts:4-7', () => {
    const state = stateOf(SOURCE);
    const copied = copiedSelection(state, span(state, 4, 7));

    expect(copied.text).toBe('const line4 = 4;\nconst line5 = 5;\nconst line6 = 6;\nconst line7 = 7;');
    expect(
      referenceUnder({ root: ROOT, path: `${ROOT}/src/x.ts`, line: copied.fromLine, endLine: copied.toLine }),
    ).toBe('@src/x.ts:4-7');
  });

  it('answers one line with @src/x.ts:4, and never with a range of one', () => {
    const state = stateOf(SOURCE);
    const copied = copiedSelection(state, span(state, 4, 4));

    expect(
      referenceUnder({ root: ROOT, path: `${ROOT}/src/x.ts`, line: copied.fromLine, endLine: copied.toLine }),
    ).toBe('@src/x.ts:4');
  });

  it('does not count a line the selection only reached the start of', () => {
    // Dragging to the end of line 7 and on to the newline lands on the start of
    // line 8, which the reader did not select and must not be named.
    const state = stateOf(SOURCE);
    const copied = copiedSelection(state, { from: state.doc.line(4).from, to: state.doc.line(8).from });

    expect(copied.toLine).toBe(7);
  });

  it('keeps the whole path of a file that is not under the root', () => {
    expect(referenceUnder({ root: ROOT, path: '/etc/hosts', line: 3, endLine: 3 })).toBe('@/etc/hosts:3');
  });
});

describe('the code itself is still one click away', () => {
  it('copies the file when the header button is pressed with nothing selected', async () => {
    render(<FileViewer root={ROOT} path={`${ROOT}/src/x.ts`} file={{ kind: 'text', text: SOURCE, size: SOURCE.length }} />);
    await waitFor(() => expect(screen.getByTestId('file-viewer-copy-text')).toBeTruthy());

    fireEvent.click(screen.getByTestId('file-viewer-copy-text'));
    expect(clipboard).toBe(SOURCE);
  });
});

describe('the tree hands over a reference too', () => {
  it('copies @src/ for a folder and @x.ts for a file', async () => {
    render(<FileTree root={ROOT} selected={null} onOpen={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryAllByTestId('files-tree-row').length).toBeGreaterThan(0));

    const rowFor = (path: string) =>
      screen.getByTestId('files-tree-row-list').querySelector(`[data-path="${path}"]`) as HTMLElement;

    fireEvent.contextMenu(rowFor(`${ROOT}/src`));
    fireEvent.click(screen.getByTestId('path-menu-copy-reference'));
    expect(clipboard, 'a folder is a reference with a slash on the end').toBe('@src/');

    fireEvent.contextMenu(rowFor(`${ROOT}/x.ts`));
    fireEvent.click(screen.getByTestId('path-menu-copy-reference'));
    expect(clipboard).toBe('@x.ts');
  });

  it('takes the menu away once it has been used', async () => {
    render(<FileTree root={ROOT} selected={null} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.queryAllByTestId('files-tree-row').length).toBeGreaterThan(0));

    const row = screen.getByTestId('files-tree-row-list').querySelector(`[data-path="${ROOT}/src"]`) as HTMLElement;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByTestId('path-menu-copy-reference'));
    expect(screen.queryByTestId('files-tree-menu')).toBeNull();
  });
});
