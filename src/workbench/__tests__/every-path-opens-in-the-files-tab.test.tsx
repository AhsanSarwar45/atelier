/**
 * Where a file path goes when somebody clicks it (bw-g3o3.9).
 *
 * The app is meant to be a whole coding environment, so the plain click stays
 * inside it: the Files tab, on the line the address named. The two ways out are
 * still there — Alt-click for the editor, and a right-click menu for everywhere
 * else — and a file that belongs to no checkout of ours, which the Files tab
 * could not draw, leaves for the desktop exactly as it always did.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { PathsOpenProvider, checkoutOf, referenceFor, usePathActions } from '@/workbench/open-path';
import { PathChip } from '@/workbench/path-chip';

const went = vi.hoisted(() => ({ to: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: went.to }),
  useSearchParams: () => new URLSearchParams('id=p1&tab=chat'),
}));

const desktop = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/workbench/open-local-path', () => ({ openLocalPath: desktop.open }));

const said = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ toast: said.toast }));

const asked = vi.hoisted(() => ({ trees: vi.fn() }));
vi.mock('@/lib/api', () => ({ git: { trees: asked.trees } }));

const PROJECT = '/home/me/project';
const TREE = '/home/me/project/worktrees/bw-1';

/**
 * The provider has to be the one holding the handlers, or the handlers read the
 * fallback rather than the project. Drawn the way the screens draw it.
 */
function draw(absolute: string, line: number | null = null) {
  function Inside() {
    const paths = usePathActions();
    return (
      <div {...paths.chips} data-testid="bench">
        <PathChip absolute={absolute} raw={absolute} line={line} endLine={line === null ? null : line + 2} />
        {paths.menu}
      </div>
    );
  }
  return render(
    <PathsOpenProvider projectPath={PROJECT}>
      <Inside />
    </PathsOpenProvider>,
  );
}

/** Wait for the worktrees to have been read, since that is what decides. */
async function readyChip() {
  await waitFor(() => expect(asked.trees).toHaveBeenCalled());
  return screen.getByTestId('path-chip');
}

describe('which checkout a path belongs to', () => {
  it('answers with the longest one, because a worktree sits inside its project', () => {
    expect(checkoutOf(`${TREE}/src/a.ts`, [PROJECT, TREE])).toBe(TREE);
    expect(checkoutOf(`${PROJECT}/src/a.ts`, [PROJECT, TREE])).toBe(PROJECT);
  });

  it('answers with nothing for a file that belongs to none of them', () => {
    expect(checkoutOf('/etc/hosts', [PROJECT, TREE])).toBeNull();
    // A folder whose name merely starts the same way is a different folder.
    expect(checkoutOf('/home/me/project-notes/a.ts', [PROJECT])).toBeNull();
  });

  it('writes the reference relative to that checkout, in the one grammar', () => {
    expect(referenceFor({ absolute: `${TREE}/src/a.ts`, line: 3, endLine: 9 }, [PROJECT, TREE]))
      .toBe('@src/a.ts:3-9');
    expect(referenceFor({ absolute: '/etc/hosts', line: null, endLine: null }, [PROJECT])).toBe('@/etc/hosts');
  });
});

describe('clicking a path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asked.trees.mockResolvedValue({ trees: [{ path: PROJECT }, { path: TREE }], place: PROJECT });
  });

  it('opens it in the Files tab, at its line, without leaving the app', async () => {
    draw(`${PROJECT}/src/a.ts`, 12);
    fireEvent.click(await readyChip());

    expect(went.to).toHaveBeenCalledWith(
      `/project?id=p1&tab=files&file=${encodeURIComponent(`${PROJECT}/src/a.ts`)}&line=12`,
    );
    expect(desktop.open).not.toHaveBeenCalled();
  });

  it('opens a file in one of the project worktrees the same way', async () => {
    draw(`${TREE}/src/a.ts`);
    fireEvent.click(await readyChip());

    expect(went.to).toHaveBeenCalledWith(
      `/project?id=p1&tab=files&file=${encodeURIComponent(`${TREE}/src/a.ts`)}`,
    );
  });

  it('leaves for the editor when the reader holds Alt', async () => {
    draw(`${PROJECT}/src/a.ts`, 12);
    fireEvent.click(await readyChip(), { altKey: true });

    expect(desktop.open).toHaveBeenCalledWith(`${PROJECT}/src/a.ts`, 'vscode', 12);
    expect(went.to).not.toHaveBeenCalled();
  });

  it('leaves for the desktop for a file the Files tab could not draw', async () => {
    draw('/etc/hosts');
    fireEvent.click(await readyChip());

    expect(went.to).not.toHaveBeenCalled();
    expect(desktop.open).toHaveBeenCalledWith('/etc/hosts', 'finder');
  });
});

describe('the menu behind a right-click on a path', () => {
  const copied = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    copied.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: copied },
      configurable: true,
    });
    asked.trees.mockResolvedValue({ trees: [{ path: PROJECT }, { path: TREE }], place: PROJECT });
  });

  /** Right-click the chip and hand back the menu it raised. */
  async function menuOver(absolute: string, line: number | null = null) {
    draw(absolute, line);
    fireEvent.contextMenu(await readyChip(), { clientX: 40, clientY: 60 });
    return await screen.findByTestId('path-menu');
  }

  it('offers all five places a path can go', async () => {
    const menu = await menuOver(`${PROJECT}/src/a.ts`, 3);
    for (const what of ['files', 'editor', 'reveal', 'copy-path', 'copy-reference']) {
      expect(menu.querySelector(`[data-testid="path-menu-${what}"]`)).not.toBeNull();
    }
  });

  it('opens the file in the Files tab from the menu', async () => {
    const menu = await menuOver(`${PROJECT}/src/a.ts`, 3);
    fireEvent.click(menu.querySelector('[data-testid="path-menu-files"]')!);
    await waitFor(() => expect(went.to).toHaveBeenCalled());
    expect(went.to).toHaveBeenCalledWith(
      `/project?id=p1&tab=files&file=${encodeURIComponent(`${PROJECT}/src/a.ts`)}&line=3`,
    );
  });

  it('sends the file to the editor from the menu', async () => {
    const menu = await menuOver(`${PROJECT}/src/a.ts`, 3);
    fireEvent.click(menu.querySelector('[data-testid="path-menu-editor"]')!);
    await waitFor(() => expect(desktop.open).toHaveBeenCalledWith(`${PROJECT}/src/a.ts`, 'vscode', 3));
  });

  it('shows the file in the file manager from the menu', async () => {
    const menu = await menuOver(`${PROJECT}/src/a.ts`, 3);
    fireEvent.click(menu.querySelector('[data-testid="path-menu-reveal"]')!);
    await waitFor(() => expect(desktop.open).toHaveBeenCalledWith(`${PROJECT}/src/a.ts`, 'finder'));
  });

  it('copies the whole path', async () => {
    const menu = await menuOver(`${PROJECT}/src/a.ts`, 3);
    fireEvent.click(menu.querySelector('[data-testid="path-menu-copy-path"]')!);
    await waitFor(() => expect(copied).toHaveBeenCalledWith(`${PROJECT}/src/a.ts`));
  });

  it("copies a reference in this app's own grammar rather than a hand-built one", async () => {
    const menu = await menuOver(`${PROJECT}/src/a.ts`, 3);
    fireEvent.click(menu.querySelector('[data-testid="path-menu-copy-reference"]')!);
    // The chip carried lines three to five, and that is what a reader pasting
    // this into a chat means to say (`references.ts`).
    await waitFor(() => expect(copied).toHaveBeenCalledWith('@src/a.ts:3-5'));
  });

  it('greys out the Files tab for a file that lives outside the project', async () => {
    const menu = await menuOver('/etc/hosts');
    expect(menu.querySelector('[data-testid="path-menu-files"]')).toHaveAttribute('data-disabled');
    expect(menu.querySelector('[data-testid="path-menu-editor"]')).not.toHaveAttribute('data-disabled');
  });
});
