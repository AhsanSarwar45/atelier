'use client';

/**
 * The Files tab: the project's own files, beside a view of the one being read.
 *
 * This is the room and not yet the furniture (bw-g3o3.4). The tree that fills
 * the rail (`file-tree.tsx`) and the viewer that fills the centre
 * (`file-viewer.tsx`) are separate cards, so the two places they will stand are
 * marked here by name and left quiet until then. What IS settled is everything
 * the two of them have to agree about: which checkout the files are being read
 * out of, how wide the rail is, and that both survive a reload.
 *
 * The root matters more than it looks. A project with worktrees has the same
 * file at several paths at once, on different branches, and a tree that quietly
 * assumed the project's own checkout would show a reader the wrong copy of the
 * file they were sure they had just edited. So it is a choice, made in the one
 * place the files are shown, and remembered per project.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';

import { Picker } from '@/components/ui/picker';
import * as api from '@/lib/api';
import type { GitTree } from '@/lib/api';
import { ResizeDivider, DEFAULT_PANEL_WIDTH, rememberedPanelWidth } from '@/workbench/resize-divider';

/** How wide the file rail is, the same key whichever project is open. */
export const FILES_RAIL_WIDTH = 'workbench.files-rail-width';

/** Which checkout this project's files are read out of. One key per project. */
export function filesRootKey(projectId: string | null): string {
  return `workbench.files-root.${projectId ?? 'unknown'}`;
}

/** Narrower than this and there is no viewer left to speak of. */
const MIN_VIEWER_WIDTH = 320;

export interface FilesTabProps {
  /** The project whose remembered root this is. Null while it is being read. */
  projectId: string | null;
  /** The project's own checkout — the root everything falls back to. */
  projectPath: string | null;
  /** The file the address names, absolute, or null when it names none. */
  file: string | null;
  /** The line of that file to land on, counted from one. */
  line: number | null;
}

/**
 * The checkouts the picker offers: the project first, then its worktrees in the
 * order git gave them.
 *
 * Kept apart from the drawing because "the project is always first, and is
 * always there even when git said nothing" is the rule the fallback below
 * depends on, and it is worth proving without a screen.
 */
export function rootsAmong(trees: GitTree[], projectPath: string): GitTree[] {
  const main = trees.filter((tree) => tree.isMain);
  const rest = trees.filter((tree) => !tree.isMain);
  if (main.length > 0) return [...main, ...rest];
  // Git could not be read, or this project is no repository at all. The folder
  // itself is still a folder full of files, so it is still offered.
  return [{ name: folderName(projectPath), path: projectPath, branch: null, isMain: true, dirty: false, ahead: 0, behind: 0 }, ...rest];
}

/** The last segment of a path — what a checkout is called on screen. */
export function folderName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

/**
 * The root actually shown: the remembered one while it is still among the
 * checkouts, and the project otherwise.
 *
 * A worktree is a folder somebody can delete from a terminal, and a remembered
 * path that no longer exists is a tab that reads an empty tree and says nothing
 * about why. Falling back to the project is the one root that cannot go away
 * while the project itself is open.
 */
export function rootShown(roots: GitTree[], remembered: string | null, projectPath: string): string {
  if (remembered && roots.some((root) => root.path === remembered)) return remembered;
  return roots.find((root) => root.isMain)?.path ?? projectPath;
}

export default function FilesTab({ projectId, projectPath, file, line }: FilesTabProps) {
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [trees, setTrees] = useState<GitTree[]>([]);
  const [remembered, setRemembered] = useState<string | null>(null);

  useEffect(() => {
    setWidth(rememberedPanelWidth(FILES_RAIL_WIDTH));
  }, []);

  const changeWidth = useCallback((next: number) => {
    setWidth(next);
    localStorage.setItem(FILES_RAIL_WIDTH, String(Math.round(next)));
  }, []);

  useEffect(() => {
    setRemembered(localStorage.getItem(filesRootKey(projectId)));
  }, [projectId]);

  useEffect(() => {
    if (!projectPath) return;
    const stop = new AbortController();
    let live = true;
    api.git
      .trees(projectPath, stop.signal)
      .then((answer) => {
        if (live) setTrees(answer.trees);
      })
      .catch(() => {
        // Not a repository, or git would not answer. The project's own folder
        // is still readable, and `rootsAmong` puts it back on its own.
        if (live) setTrees([]);
      });
    return () => {
      live = false;
      stop.abort();
    };
  }, [projectPath]);

  const roots = useMemo(
    () => (projectPath ? rootsAmong(trees, projectPath) : []),
    [trees, projectPath],
  );
  const root = projectPath ? rootShown(roots, remembered, projectPath) : null;

  const chooseRoot = useCallback(
    (next: string) => {
      setRemembered(next);
      localStorage.setItem(filesRootKey(projectId), next);
    },
    [projectId],
  );

  return (
    <div className="flex min-h-0 flex-1" data-testid="files-tab" data-root={root ?? undefined}>
      <div
        data-testid="files-rail"
        style={{ '--files-rail-width': `${width}px` } as CSSProperties}
        className="flex h-full w-[var(--files-rail-width)] shrink-0 flex-col border-r border-border/40"
      >
        <div className="shrink-0 border-b border-border/40 p-2">
          <Picker
            label="Files root"
            data-testid="files-root"
            placeholder="Select a checkout"
            searchPlaceholder="Search checkouts"
            empty="No checkout matches"
            value={root ?? ''}
            onChange={chooseRoot}
            choices={roots.map((tree) => ({
              value: tree.path,
              label: tree.name,
              // The branch, dimmed, is what tells two worktrees of one project
              // apart when their folders are named after the same job.
              hint: tree.isMain ? undefined : (tree.branch ?? 'detached'),
              keywords: tree.path,
            }))}
          />
        </div>
        {/* The tree itself (bw-g3o3.12) goes here, reading `root`. */}
        <div className="min-h-0 flex-1 overflow-auto" data-testid="files-tree-slot" />
      </div>
      <ResizeDivider
        side="left"
        value={width}
        onChange={changeWidth}
        maximum={() => (typeof window === 'undefined' ? Infinity : window.innerWidth - MIN_VIEWER_WIDTH)}
      />
      {/* The viewer (bw-g3o3.17) goes here, reading `root`, `file` and `line`. */}
      <div
        className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
        data-testid="files-viewer"
        data-file={file ?? undefined}
        data-line={line ?? undefined}
      >
        <p className="text-sm text-muted-foreground">Pick a file</p>
      </div>
    </div>
  );
}
