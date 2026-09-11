/**
 * The file tree (bw-g3o3.12).
 *
 * What is proved here is everything a reader would notice and could not see in
 * a screenshot: that a folder is read when it is opened and not before, that
 * the icon beside a name is the one that name deserves, that the four arrows
 * and Enter move the way a tree's arrows move anywhere else, and that git's
 * word about a file is the colour of its name.
 *
 * The server is a fake disk here. The real `/api/fs/tree` is proved against a
 * real filesystem in the Rust tests (bw-g3o3.2), and the two halves meeting in
 * a browser is the end-to-end case beside this.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** What is on disk: one level per directory, as the server would answer. */
const disk = new Map<string, FsTreeEntry[]>();

/** Every directory that has been read, in the order it was read. */
let asked: string[] = [];

/** What git says, which a case rewrites before it renders. */
let says: GitStatus = blank();

function blank(): GitStatus {
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
      tree: async (dir: string) => {
        asked.push(dir);
        return { dir, entries: disk.get(dir) ?? [] };
      },
      // The wire is proved on its own (bw-g3o3.3); here it only has to exist
      // and to be let go of again.
      watch: () => () => {},
    },
    git: { ...actual.git, status: async () => says, watch: () => () => {} },
  };
});

// Everything below is imported after the fake: importing any of it imports the
// api module the fake replaces. The types are erased, so their position is only
// a matter of keeping them beside what they are read with.
// eslint-disable-next-line import/first
import { iconForFile, iconForFolder } from '@/components/file-icon';
// eslint-disable-next-line import/first
import type { FsTreeEntry, GitStatus } from '@/lib/api';
// eslint-disable-next-line import/first
import FileTree, { ancestorsOf, rowsOf, statusByPath } from '@/workbench/file-tree';

const ROOT = '/work/atelier';

/**
 * jsdom has no layout, so every box is nought high — and a virtualiser told its
 * viewport is nought high draws no rows at all. Lending the bench a viewport is
 * what makes the tree under test the tree a browser would draw.
 */
beforeAll(() => {
  for (const [side, size] of [['offsetHeight', 600], ['clientHeight', 600], ['offsetWidth', 320], ['clientWidth', 320]] as const) {
    Object.defineProperty(HTMLElement.prototype, side, { configurable: true, get: () => size });
  }
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 320, height: 600, top: 0, left: 0, right: 320, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  HTMLElement.prototype.scrollTo = () => {};
});

/** One entry of a directory, with the flags a case does not care about. */
function entry(path: string, kind: FsTreeEntry['kind'], ignored = false): FsTreeEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { name, path, kind, size: 0, mtime: 0, ignored, hidden: name.startsWith('.') };
}

/** Put a directory on the fake disk. */
function folder(dir: string, ...entries: FsTreeEntry[]): void {
  disk.set(dir, entries);
}

async function settled(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Every row the tree is drawing, by path, top to bottom. */
function drawn(): string[] {
  return screen.queryAllByTestId('files-tree-row').map((row) => row.dataset.path!);
}

function row(path: string): HTMLElement {
  return screen.getByTestId('files-tree-row-list').querySelector(`[data-path="${path}"]`) as HTMLElement;
}

/** A tree on the fake disk, already showing its root. */
async function tree(selected: string | null = null, onOpen = vi.fn()) {
  const drawing = render(<FileTree root={ROOT} selected={selected} onOpen={onOpen} />);
  await settled();
  await waitFor(() => expect(screen.queryAllByTestId('files-tree-row').length).toBeGreaterThan(0));
  return { drawing, onOpen };
}

/** The keys go to the scroller, which is the tree's one tab stop. */
function press(key: string): void {
  fireEvent.keyDown(screen.getByTestId('files-tree-scroller'), { key });
}

/** Where the arrow keys are standing. */
function cursor(): string | null {
  return screen.queryAllByTestId('files-tree-row').find((r) => r.dataset.cursor === 'yes')?.dataset.path ?? null;
}

beforeEach(() => {
  disk.clear();
  asked = [];
  says = blank();
  localStorage.clear();
  folder(ROOT, entry(`${ROOT}/src`, 'dir'), entry(`${ROOT}/README.md`, 'file'));
  folder(`${ROOT}/src`, entry(`${ROOT}/src/lib`, 'dir'), entry(`${ROOT}/src/main.ts`, 'file'));
  folder(`${ROOT}/src/lib`, entry(`${ROOT}/src/lib/deep.ts`, 'file'));
});

describe('a folder is read when it is opened, and not before', () => {
  it('draws the root and asks about nothing under it', async () => {
    await tree();

    expect(drawn()).toEqual([`${ROOT}/src`, `${ROOT}/README.md`]);
    expect(asked, 'the tree read more than the one level it draws').toEqual([ROOT]);
  });

  it('reads one level when a folder is opened, and nests what comes back', async () => {
    await tree();

    fireEvent.click(screen.getByTestId('files-tree-row-list').querySelector(`[data-path="${ROOT}/src"]`)!);
    await waitFor(() => expect(drawn()).toContain(`${ROOT}/src/main.ts`));

    // Its own level, and only its own: `src/lib` is drawn shut and unread.
    expect(asked).toEqual([ROOT, `${ROOT}/src`]);
    expect(drawn()).toEqual([
      `${ROOT}/src`,
      `${ROOT}/src/lib`,
      `${ROOT}/src/main.ts`,
      `${ROOT}/README.md`,
    ]);
    expect(row(`${ROOT}/src/main.ts`).dataset.depth).toBe('1');
    // One indent guide per level crossed, so the hairlines line up down the
    // rail rather than being a background the rows sit on.
    expect(row(`${ROOT}/src`).querySelectorAll('[data-testid="files-tree-guide"]')).toHaveLength(0);
    expect(row(`${ROOT}/src/main.ts`).querySelectorAll('[data-testid="files-tree-guide"]')).toHaveLength(1);
    expect(row(`${ROOT}/src`).getAttribute('aria-expanded')).toBe('true');
    expect(row(`${ROOT}/src/lib`).getAttribute('aria-expanded')).toBe('false');

    // Shutting it again puts the level away without forgetting it: reopening
    // costs no read at all.
    fireEvent.click(row(`${ROOT}/src`));
    await settled();
    expect(drawn()).toEqual([`${ROOT}/src`, `${ROOT}/README.md`]);
    fireEvent.click(row(`${ROOT}/src`));
    await settled();
    expect(drawn()).toContain(`${ROOT}/src/main.ts`);
    expect(asked).toEqual([ROOT, `${ROOT}/src`]);
  });

  it('opens every folder above the file the address names', async () => {
    await tree(`${ROOT}/src/lib/deep.ts`);

    await waitFor(() => expect(drawn()).toContain(`${ROOT}/src/lib/deep.ts`));
    expect(asked).toEqual([ROOT, `${ROOT}/src`, `${ROOT}/src/lib`]);
    expect(row(`${ROOT}/src/lib/deep.ts`).getAttribute('aria-selected')).toBe('true');
  });

  it('flattens only what is open', () => {
    const read = new Map([
      [ROOT, disk.get(ROOT)!],
      [`${ROOT}/src`, disk.get(`${ROOT}/src`)!],
    ]);
    const shut = rowsOf(read, ROOT, new Set(), true);
    expect(shut.map((r) => r.entry.path)).toEqual([`${ROOT}/src`, `${ROOT}/README.md`]);
    const open = rowsOf(read, ROOT, new Set([`${ROOT}/src`]), true);
    expect(open.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
  });

  it('names the folders above a file, and nothing for a file outside the root', () => {
    expect(ancestorsOf(ROOT, `${ROOT}/src/lib/deep.ts`)).toEqual([`${ROOT}/src`, `${ROOT}/src/lib`]);
    expect(ancestorsOf(ROOT, '/elsewhere/deep.ts')).toEqual([]);
  });
});

describe('the icon beside a name', () => {
  it('knows a file by its ending, and a name that means more than its ending', () => {
    expect(iconForFile('main.ts')).toBe('typescript');
    expect(iconForFile('tsconfig.json')).toBe('tsconfig');
    expect(iconForFile('data.json')).toBe('json');
    expect(iconForFile('Dockerfile')).toBe('docker');
    // The whole name beats the ending: `package.json` is Node, not JSON.
    expect(iconForFile('package.json')).toBe('nodejs');
    // The longest ending wins, so a declaration file is not merely TypeScript.
    expect(iconForFile('globals.d.ts')).toBe('typescript-def');
  });

  it('knows a folder, and knows it is open', () => {
    expect(iconForFolder('src', false)).toBe('folder-src');
    expect(iconForFolder('src', true)).toBe('folder-src-open');
  });

  it('has nothing to say about what the pruned table does not carry', () => {
    expect(iconForFile('notes.wibble')).toBeNull();
    expect(iconForFolder('wibble', false)).toBeNull();
  });

  it('draws the material icon as a static image, and a lucide glyph when there is none', async () => {
    folder(ROOT, entry(`${ROOT}/src`, 'dir'), entry(`${ROOT}/main.ts`, 'file'), entry(`${ROOT}/notes.wibble`, 'file'));
    await tree();

    const picture = row(`${ROOT}/main.ts`).querySelector('img')!;
    expect(picture.getAttribute('src')).toBe('/file-icons/typescript.svg');
    expect(row(`${ROOT}/src`).querySelector('[data-icon="folder-src"]')).not.toBeNull();
    // Nothing in the table matches, so the app's own glyph stands in — an
    // outline, not a gap where a picture should be.
    expect(row(`${ROOT}/notes.wibble`).querySelector('[data-icon="lucide"]')).not.toBeNull();
  });
});

describe('the arrow keys walk the tree', () => {
  it('goes down and up the rows that are showing', async () => {
    await tree();
    press('ArrowDown');
    expect(cursor()).toBe(`${ROOT}/src`);
    press('ArrowDown');
    expect(cursor()).toBe(`${ROOT}/README.md`);
    // The last row is the last row: down again stays put rather than falling off.
    press('ArrowDown');
    expect(cursor()).toBe(`${ROOT}/README.md`);
    press('ArrowUp');
    expect(cursor()).toBe(`${ROOT}/src`);
  });

  it('opens with right, steps into what it opened, and shuts with left', async () => {
    await tree();
    press('ArrowDown');
    press('ArrowRight');
    await waitFor(() => expect(drawn()).toContain(`${ROOT}/src/main.ts`));
    // The folder opened but the cursor did not move: right again is the step in.
    expect(cursor()).toBe(`${ROOT}/src`);
    press('ArrowRight');
    expect(cursor()).toBe(`${ROOT}/src/lib`);

    // Left on a shut row is "out to the folder I am in".
    press('ArrowLeft');
    expect(cursor()).toBe(`${ROOT}/src`);
    // And left on an open one shuts it.
    press('ArrowLeft');
    await waitFor(() => expect(drawn()).not.toContain(`${ROOT}/src/main.ts`));
  });

  it('opens a file with Enter and toggles a folder with it', async () => {
    const { onOpen } = await tree();
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    expect(onOpen).toHaveBeenCalledWith(`${ROOT}/README.md`);

    // Enter on a folder is the same as clicking it: it opens the folder and
    // opens no file.
    press('ArrowUp');
    press('Enter');
    await waitFor(() => expect(drawn()).toContain(`${ROOT}/src/main.ts`));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('git says what colour a name is', () => {
  it('reads the rail’s own palette rather than a second one', () => {
    says = {
      ...blank(),
      staged: [{ path: 'src/added.ts', status: 'added', origPath: null }],
      unstaged: [{ path: 'README.md', status: 'modified', origPath: null }],
      untracked: [{ path: 'new.ts' }],
      conflicted: [{ path: 'src/main.ts' }],
    };
    const by = statusByPath(says, ROOT);
    expect(by.get(`${ROOT}/src/added.ts`)).toBe('added');
    expect(by.get(`${ROOT}/README.md`)).toBe('modified');
    expect(by.get(`${ROOT}/new.ts`)).toBe('untracked');
    // A file git lists twice is drawn as the more urgent of the two.
    expect(by.get(`${ROOT}/src/main.ts`)).toBe('conflicted');
  });

  it('paints the names it has an answer for, and leaves the rest alone', async () => {
    says = {
      ...blank(),
      unstaged: [{ path: 'README.md', status: 'modified', origPath: null }],
      untracked: [{ path: 'notes.txt' }],
    };
    folder(ROOT, entry(`${ROOT}/README.md`, 'file'), entry(`${ROOT}/notes.txt`, 'file'), entry(`${ROOT}/quiet.ts`, 'file'));
    await tree();

    await waitFor(() => expect(row(`${ROOT}/README.md`).dataset.status).toBe('modified'));
    expect(row(`${ROOT}/README.md`).querySelector('.text-warning')).not.toBeNull();
    expect(row(`${ROOT}/notes.txt`).querySelector('.text-info')).not.toBeNull();
    expect(row(`${ROOT}/quiet.ts`).dataset.status).toBeUndefined();
  });
});

describe('what git ignores', () => {
  it('dims it, and hides it when the reader says so', async () => {
    folder(ROOT, entry(`${ROOT}/src`, 'dir'), entry(`${ROOT}/dist`, 'dir', true));
    await tree();

    expect(drawn()).toContain(`${ROOT}/dist`);
    expect(row(`${ROOT}/dist`).className).toContain('opacity-45');

    fireEvent.click(screen.getByTestId('files-ignored-toggle'));
    await waitFor(() => expect(drawn()).not.toContain(`${ROOT}/dist`));
    // And the answer is remembered, the way the rail's width is.
    expect(localStorage.getItem('workbench.files-hide-ignored')).toBe('1');
  });
});
