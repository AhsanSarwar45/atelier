/**
 * A diff of thousands of files draws a screenful of them (bw-o5i3.5).
 *
 * The column mounted a section for every changed and untracked path. On a
 * checkout git reported 5,104 of them for, opening one file's diff put 74,318
 * nodes in the document and cost one long task of 1,622 ms — the whole screen,
 * both tabs, stopped answering for a second and a half because a cache
 * directory was not ignored.
 *
 * What is asserted here is the two shapes and the join between them: an
 * ordinary worktree is drawn whole in the column's own scroll, a huge one is
 * drawn a window at a time, and a file picked out of the rail is still reached
 * when it is one the window is nowhere near.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitDiffFile } from '@/lib/api';
import { GitDiffView } from '@/workbench/git-diff-view';
import { PathsOpenProvider } from '@/workbench/open-path';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('id=p1&tab=chat'),
}));

const calls = vi.hoisted(() => ({ diff: vi.fn(), watch: vi.fn(), trees: vi.fn() }));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

vi.mock('@/workbench/open-local-path', () => ({ openLocalPath: vi.fn() }));

const paint = vi.hoisted(() => ({ lines: vi.fn() }));

vi.mock('@/workbench/colouring', async (whatItReallyIs) => {
  const real = await whatItReallyIs<Record<string, unknown>>();
  return {
    ...real,
    paintLines: (...said: unknown[]) => {
      paint.lines(...said);
      return (real.paintLines as (...a: unknown[]) => string[] | null)(...said);
    },
  };
});

/**
 * jsdom has no layout, so every box is nought high — and a virtualiser told
 * its viewport is nought high draws no sections at all, while one told the
 * scroll has nowhere to go refuses to bring anything into view.
 */
beforeAll(() => {
  for (const [side, size] of [['offsetHeight', 800], ['clientHeight', 800], ['offsetWidth', 900], ['clientWidth', 900], ['scrollHeight', 10_000_000], ['scrollWidth', 900]] as const) {
    Object.defineProperty(HTMLElement.prototype, side, { configurable: true, get: () => size });
  }
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 900, height: 800, top: 0, left: 0, right: 900, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  // jsdom keeps no scroll of its own, so a box asked to scroll has to be told
  // it did — otherwise a virtualiser asked to bring a section never moves.
  HTMLElement.prototype.scrollTo = function (to?: ScrollToOptions | number) {
    const top = typeof to === 'number' ? to : (to?.top ?? 0);
    Object.defineProperty(this, 'scrollTop', { configurable: true, value: top, writable: true });
    this.dispatchEvent(new Event('scroll'));
  };
  HTMLElement.prototype.scrollIntoView = () => {};
});

const REPO = '/tmp/a-worktree';

/** An untracked file of one line, which is what a cache directory is full of. */
function oneLine(path: string): GitDiffFile {
  return {
    path,
    oldPath: null,
    status: 'untracked',
    additions: 1,
    deletions: 0,
    binary: false,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: 'added' as const, text: 'x' }] }],
  };
}

/** A tracked file with `count` changed lines, which is a thing worth colouring. */
function changed(path: string, count: number): GitDiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    additions: count,
    deletions: 0,
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: count,
        lines: Array.from({ length: count }, (_, at) => ({ kind: 'added' as const, text: `const named${at} = ${at};` })),
      },
    ],
  };
}

function manyFiles(howMany: number): GitDiffFile[] {
  return Array.from({ length: howMany }, (_, at) => oneLine(`.cache/thing-${String(at).padStart(4, '0')}.dat`));
}

function draw(files: GitDiffFile[], focus?: { path: string; asked: number }) {
  calls.diff.mockResolvedValue({ files });
  return render(
    <PathsOpenProvider projectPath={REPO}>
      <GitDiffView path={REPO} focus={focus ?? null} />
    </PathsOpenProvider>,
  );
}

describe('a worktree with thousands of changed files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.watch.mockReturnValue(() => {});
    calls.trees.mockResolvedValue({
      trees: [{ name: 'a-worktree', path: REPO, branch: 'main', isMain: true, dirty: false, ahead: 0, behind: 0 }],
      place: REPO,
    });
  });

  it('draws a window of sections, not one per file', async () => {
    draw(manyFiles(5_000));

    await waitFor(() => expect(screen.queryByTestId('git-diff-window')).not.toBeNull());
    const drawn = screen.getAllByTestId('git-diff-file').length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(200);
    expect(document.querySelectorAll('*').length).toBeLessThan(6_000);
  }, 60_000);

  it('does not colour a file again when the five-second re-read brings no news', async () => {
    // A diff re-reads itself while the reader is looking at it. Every read
    // parses fresh objects, and colouring is the expensive thing hanging off
    // them, so a file nothing has happened to has to come back as the file it
    // already was or every open section is coloured again on every tick.
    const files = [changed('src/one.ts', 8)];
    draw(files);
    await waitFor(() => expect(screen.getAllByTestId('git-diff-file')).toHaveLength(1));
    const first = paint.lines.mock.calls.length;
    expect(first).toBeGreaterThan(0);

    // The same news, freshly parsed, exactly as the server would send it back.
    calls.diff.mockResolvedValue({ files: JSON.parse(JSON.stringify(files)) });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(paint.lines.mock.calls.length).toBe(first);
  });

  it('leaves an ordinary worktree drawn whole', async () => {
    draw(manyFiles(30));

    await waitFor(() => expect(screen.getAllByTestId('git-diff-file')).toHaveLength(30));
    expect(screen.queryByTestId('git-diff-window')).toBeNull();
  });

  it('reaches a file the window is nowhere near when the rail picks it', async () => {
    const wanted = '.cache/thing-4000.dat';
    draw(manyFiles(5_000), { path: wanted, asked: 1 });

    // The virtualiser is asked to bring it, so it is drawn even though it sits
    // four thousand sections below the one the column opened on.
    await waitFor(() =>
      expect(
        screen.getAllByTestId('git-diff-file').some((one) => one.getAttribute('data-path') === wanted),
      ).toBe(true),
    );
  }, 60_000);
});
