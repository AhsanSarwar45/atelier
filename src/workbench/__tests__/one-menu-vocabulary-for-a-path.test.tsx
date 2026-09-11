/**
 * The two menus over a path say the same things (bw-wk5u.3).
 *
 * The app has two of them — the Files tree's right-click, and the one behind a
 * path named in a chat, a card field or a comment. They were written by hand,
 * separately, and each ended up with half the vocabulary: the tree could rename
 * and delete but offered no way out of the app, the chip could leave for an
 * editor but could not create anything. Nothing failed. A reader learned one
 * menu and was quietly wrong at the other for months.
 *
 * So this is the case that would have caught it. Both menus are opened over a
 * file in the same checkout and every item is read off each, and the two lists
 * must be the same list — and must be `PATH_MENU_ITEMS`, which is what
 * `path-menu.tsx` promises it offers. An action added to that list and drawn by
 * only one of them fails here; so does an item hand-written into either menu.
 */
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

const ROOT = '/home/reader/project';
const FILE = `${ROOT}/x.ts`;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('id=p1&tab=chat'),
}));

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
    git: {
      ...actual.git,
      status: async () => blankStatus(),
      watch: () => () => {},
      trees: async () => ({ trees: [{ path: ROOT }], place: ROOT }),
    },
  };
});

// eslint-disable-next-line import/first
import type { FsTreeEntry, GitStatus } from '@/lib/api';
// eslint-disable-next-line import/first
import FileTree from '@/workbench/file-tree';
// eslint-disable-next-line import/first
import { PathsOpenProvider } from '@/workbench/open-path';
// eslint-disable-next-line import/first
import { PathChip } from '@/workbench/path-chip';
// eslint-disable-next-line import/first
import { PATH_MENU_ITEMS, usePathActions } from '@/workbench/path-menu';

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
  disk.clear();
  disk.set(ROOT, [
    { name: 'x.ts', path: FILE, kind: 'file', size: 12, mtime: 0, ignored: false, hidden: false },
  ]);
});

/** The marks of every item a menu is drawing, in the order it draws them. */
function itemsOf(menu: HTMLElement): (string | null)[] {
  return [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.getAttribute('data-testid'));
}

/** Right-click the file in the Files tree and read its menu. */
async function treeMenu(): Promise<(string | null)[]> {
  render(<FileTree root={ROOT} selected={null} onOpen={vi.fn()} />);
  await waitFor(() => expect(screen.queryAllByTestId('files-tree-row').length).toBeGreaterThan(0));
  const row = screen
    .getByTestId('files-tree-row-list')
    .querySelector(`[data-path="${FILE}"]`) as HTMLElement;
  fireEvent.contextMenu(row);
  return itemsOf(await screen.findByTestId('files-tree-menu'));
}

/** Right-click the same file named in a chat and read its menu. */
async function chipMenu(): Promise<(string | null)[]> {
  function Conversation() {
    const paths = usePathActions();
    return (
      <div {...paths.chips} data-testid="conversation">
        <PathChip absolute={FILE} raw={FILE} line={null} />
        {paths.menu}
      </div>
    );
  }
  render(
    <PathsOpenProvider projectPath={ROOT}>
      <Conversation />
    </PathsOpenProvider>,
  );
  // The checkouts are read before the menu can know the file is in one of them,
  // and which items are offered turns on that.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  fireEvent.contextMenu(screen.getByTestId('path-chip'), { clientX: 40, clientY: 60 });
  return itemsOf(await screen.findByTestId('path-menu'));
}

describe('one menu vocabulary for a path', () => {
  it('offers the same items, in the same order, from the tree and from a chat', async () => {
    const fromTheTree = await treeMenu();
    const fromTheChat = await chipMenu();
    expect(fromTheTree, 'the tree offers something the chat does not').toEqual(fromTheChat);
  });

  it('offers exactly what the one list promises, from both', async () => {
    // Against the list rather than only against each other, so that two menus
    // that lost the same item together are still a failure.
    expect(await treeMenu(), 'the tree has drifted from the one list').toEqual([...PATH_MENU_ITEMS]);
    expect(await chipMenu(), 'the chat has drifted from the one list').toEqual([...PATH_MENU_ITEMS]);
  });
});
