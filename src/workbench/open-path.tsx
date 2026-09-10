'use client';

/**
 * Where a file path opens, decided once for the whole app (bw-g3o3.9).
 *
 * This app is meant to be a complete coding environment, so a path named
 * anywhere in it opens in the Files tab and the reader stays where they are.
 * Sending them out to a separate editor for every file was the app admitting it
 * could not show its own project. The two ways out — the editor, the file
 * manager — are one modifier or one right-click away, which is where an escape
 * hatch belongs.
 *
 * ## Only files this app could actually draw
 *
 * The Files tab reads a tree rooted at a checkout: the project's own folder, or
 * one of the worktrees git has cut from it. A path outside all of them —
 * `/etc/hosts`, a file in another project — has nothing the tab could show, so
 * it keeps the behaviour it always had and leaves for the desktop. Which is
 * why the checkouts are read once, here, rather than by each of the hundreds of
 * chips that ask.
 *
 * ## What a menu over a path offers is not decided here
 *
 * This file answers "where does it open"; `path-menu.tsx` answers "what can be
 * done to it", for both of the app's pointer menus at once (bw-wk5u). The two
 * were once one file and the menu drifted from the tree's anyway, so the words
 * now live beside the tree's and this one keeps only the routing they call.
 *
 * ## Why it is a context and not a hook that calls the router
 *
 * The chips are drawn in card fields and comments as well as in a chat
 * (`markdown-body.tsx`), and those are drawn in tests and in places with no
 * router around them. Handing the answer down means the parts that draw a path
 * never mention navigation at all, and a path drawn outside the project screen
 * still opens the way it always did instead of throwing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import { addressWith } from '@/lib/address';
import * as api from '@/lib/api';
import { openLocalPath } from '@/workbench/open-local-path';
import { type OpenPath, type PathHow, type PathTarget } from '@/workbench/path-chip';

/** A path with no trailing slashes, so two spellings of one folder compare. */
function trimmed(root: string): string {
  return root.replace(/\/+$/, '');
}

/**
 * The checkout a path lives in — the longest one, because a worktree usually
 * sits inside the project it was cut from and the worktree is the answer the
 * reader means. Null when the path is somewhere else entirely.
 */
export function checkoutOf(path: string, checkouts: string[]): string | null {
  let best: string | null = null;
  for (const root of checkouts) {
    const base = trimmed(root);
    if (path !== base && !path.startsWith(`${base}/`)) continue;
    if (best === null || base.length > best.length) best = base;
  }
  return best;
}

/** Whether the Files tab could show this path at all. */
export function insideCheckout(path: string, checkouts: string[]): boolean {
  return checkoutOf(path, checkouts) !== null;
}

/** Everything the app knows about where a path can go. */
interface PathOpening {
  /** The project's own folder and every worktree cut from it. */
  checkouts: string[];
  open: OpenPath;
}

/**
 * Opening a path this app cannot draw: one outside every checkout, or one named
 * on a screen that has no project behind it at all. It leaves for the desktop
 * exactly as it did before there was a Files tab — the editor when a line was
 * named, because a line is the one thing only an editor can honour, and the
 * file manager otherwise.
 */
function outsideTheApp(target: PathTarget, how: PathHow): void {
  if (how === 'reveal' || target.line === null) openLocalPath(target.absolute, 'finder');
  else openLocalPath(target.absolute, 'vscode', target.line);
}

/** With no project screen around it, that is the only thing a path can do. */
const OUTSIDE: PathOpening = { checkouts: [], open: outsideTheApp };

const Opening = createContext<PathOpening>(OUTSIDE);

/**
 * Reads the project's worktrees once and settles what a click on any path
 * under it does.
 *
 * A project that is no repository, or a git that will not answer, leaves the
 * project's own folder — which is still a folder full of files.
 */
export function PathsOpenProvider({ projectPath, children }: { projectPath: string | null; children: ReactNode }) {
  const router = useRouter();
  const params = useSearchParams();
  const [worktrees, setWorktrees] = useState<string[]>([]);

  useEffect(() => {
    setWorktrees([]);
    if (!projectPath) return;
    const stop = new AbortController();
    let live = true;
    api.git
      .trees(projectPath, stop.signal)
      .then((answer) => {
        if (live) setWorktrees(answer.trees.map((tree) => tree.path));
      })
      .catch(() => {
        if (live) setWorktrees([]);
      });
    return () => {
      live = false;
      stop.abort();
    };
  }, [projectPath]);

  const checkouts = useMemo(() => {
    if (!projectPath) return worktrees;
    return [projectPath, ...worktrees.filter((path) => trimmed(path) !== trimmed(projectPath))];
  }, [projectPath, worktrees]);

  const open = useCallback<OpenPath>(
    (target, how) => {
      // The Files tab is a place in the address and nothing else, so opening a
      // file there is a push onto the history: Back gives the reader the
      // conversation they left, and what they are looking at is an address they
      // can paste to somebody else.
      if (how === 'files' && insideCheckout(target.absolute, checkouts)) {
        router.push(addressWith(params, { tab: 'files', file: target.absolute, line: target.line }));
        return;
      }
      // The editor is the only program that can be told a line, which is why
      // that is the one the escape hatch goes to.
      if (how === 'editor') {
        openLocalPath(target.absolute, 'vscode', target.line);
        return;
      }
      outsideTheApp(target, how);
    },
    [router, params, checkouts],
  );

  const opening = useMemo(() => ({ checkouts, open }), [checkouts, open]);
  return <Opening.Provider value={opening}>{children}</Opening.Provider>;
}

/** Every checkout of the project on screen. Empty until they have been read. */
export function useCheckouts(): string[] {
  return useContext(Opening).checkouts;
}

/** The one answer to "open this file", used by every path in the app. */
export function useOpenPath(): OpenPath {
  return useContext(Opening).open;
}
