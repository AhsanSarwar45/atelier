'use client';

/**
 * One menu vocabulary for a path, wherever the path was pointed at (bw-wk5u).
 *
 * There are two pointer menus over a path in this app: the Files tree's
 * (`file-tree.tsx`) and the one behind every path chip in a chat, a card field
 * or a comment (`open-path.tsx` draws it, just below). They were each written
 * by hand and each ended up with half the words — the tree could rename and
 * delete but offered no way out of the app at all, and the chip could leave for
 * an editor but not create anything. A reader learns one menu and is then wrong
 * at the other, which is worse than either menu being short.
 *
 * So the items are built once, here, and both menus ask for them. `items` is
 * the whole vocabulary; a new action added below appears in both menus without
 * either of them being touched, and `PATH_MENU_ITEMS` is that promise written
 * down so a test can hold each menu to it.
 *
 * ## Opening it here is still the default
 *
 * The app is meant to be a complete coding environment rather than a launcher
 * for somebody else's editor, so nothing about this menu changes what a plain
 * click does: a path opens in the Files tab, in this app (`open-path.tsx`).
 * The ways out are additions BESIDE that and never a replacement for it, which
 * is why "Open in Files" is first and the desktop follows it.
 *
 * ## An item that cannot apply is greyed, never dropped
 *
 * A menu that changes shape depending on what was clicked teaches nothing. A
 * reader who right-clicks `/etc/hosts` asked where this path can go, and "not
 * into the Files tab, and there is no checkout to write it relative to" is part
 * of the answer. The file operations are the one exception, and not ours to
 * make: they are dropped whole for a path outside every checkout because there
 * would be no checkout to confine the call to (`file-actions.tsx`).
 *
 * ## What leaves the app says only what it can know
 *
 * A file manager cannot be told a line and an editor can, which is the whole
 * reason the editor is a separate item from the file manager rather than one
 * "open outside" (`open-path.tsx`'s `outsideTheApp`). A shell is opened at a
 * FOLDER, so a file is asked for by the folder it sits in — which is also what
 * a reader means by "a terminal here".
 */

import { useCallback, type ReactNode } from 'react';

import { Copy, ExternalLink, Files, FolderOpen, Quote, SquareTerminal } from 'lucide-react';

import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { toast } from '@/hooks/use-toast';
import {
  FILE_ACTION_ITEMS,
  folderFor,
  useFileActions,
  type FileActions,
  type PathMoved,
} from '@/workbench/file-actions';
import { useOpenPath } from '@/workbench/open-path';
import { relativeToRoot, referenceUnder } from '@/workbench/references';
import { useTerminalShells } from '@/workbench/terminal-shells';

/**
 * A path a menu is being drawn about, however it was pointed at.
 *
 * One shape for both menus: the tree knows the checkout it is drawing and
 * whether the row is a folder, a chip knows the lines its words named, and the
 * menu needs all of it. What neither of them has, the caller says plainly —
 * `root` is null for a path in no checkout of ours, `line` is null for a path
 * named without one.
 */
export interface MenuPath {
  /** Where it is on the machine, absolute. */
  absolute: string;
  /** The checkout it lives in, or null when it is outside every one of ours. */
  root: string | null;
  /** What is there. A folder is opened and shelled into, never viewed. */
  kind: 'file' | 'dir';
  /** The first line the reader named, or null when they named none. */
  line: number | null;
  /** The last line of a range, when the words named one. */
  endLine: number | null;
}

/**
 * Every item a menu over a path offers, in the order it offers them, named by
 * the mark a test finds it by.
 *
 * This is the list the epic is about: a menu that draws anything else, or
 * misses any of these, has drifted (bw-wk5u.3).
 */
export const PATH_MENU_ITEMS = [
  'path-menu-files',
  'path-menu-editor',
  'path-menu-reveal',
  'path-menu-terminal',
  'path-menu-copy-path',
  'path-menu-copy-relative-path',
  'path-menu-copy-reference',
  ...FILE_ACTION_ITEMS,
] as const;

/** Put something on the clipboard and say so, since nothing on screen moves. */
function copyOut(text: string, said: string): void {
  const done = navigator.clipboard?.writeText(text);
  if (done) void done.then(() => toast({ title: said }));
}

/**
 * The reference a reader would paste back into a chat for this path.
 *
 * Written through `referenceUnder` and never by hand: one grammar for
 * references, wherever one is produced (`references.ts`). A path in no checkout
 * has nothing to be made relative to and keeps the whole of itself.
 */
export function referenceOf(path: MenuPath): string {
  return referenceUnder({
    root: path.root ?? '',
    path: path.absolute,
    kind: path.kind === 'dir' ? 'folder' : 'file',
    line: path.line,
    endLine: path.endLine,
  });
}

/** What a menu gets: the items to draw, and the dialogs to stand beside them. */
export interface PathMenuItems {
  /** The whole vocabulary, for one path. */
  items: (path: MenuPath) => ReactNode;
  /** Mounted once beside whichever menu drew the items. */
  dialogs: ReactNode;
}

/**
 * The one list of things a menu can offer about a path, for whichever menu asks.
 *
 * `onMoved` and `onMade` are the file operations' (`file-actions.tsx`): only
 * the screen holding open files has an answer for them, and a chip in a chat
 * changes the same disk with nothing of its own to carry.
 */
export function usePathMenuItems(onMoved?: PathMoved, onMade?: (path: string) => void): PathMenuItems {
  const open = useOpenPath();
  const { openAt } = useTerminalShells();
  const actions: FileActions = useFileActions(onMoved, onMade);

  const items = useCallback(
    (path: MenuPath) => {
      const target = { absolute: path.absolute, line: path.line, endLine: path.endLine };
      const inside = path.root !== null;
      return (
        <>
          {/* Greyed rather than hidden for a file outside the project, and for a
              folder: the viewer draws a file, and a folder is a thing this tab
              opens rather than shows. */}
          <DropdownMenuItem
            data-testid="path-menu-files"
            className="text-xs"
            disabled={!inside || path.kind === 'dir'}
            onSelect={() => open(target, 'files')}
          >
            <Files aria-hidden="true" /> Open in Files
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="path-menu-editor"
            className="text-xs"
            onSelect={() => open(target, 'editor')}
          >
            <ExternalLink aria-hidden="true" /> Open in editor
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="path-menu-reveal"
            className="text-xs"
            onSelect={() => open(target, 'reveal')}
          >
            <FolderOpen aria-hidden="true" /> Reveal in file manager
          </DropdownMenuItem>
          {/* The app's own shells, not the desktop's terminal: a coding
              environment that had to send somebody out for a command line would
              be the same admission the editor item used to be. `openAt` shows
              the window and starts one there (`terminal-shells.tsx`). */}
          <DropdownMenuItem
            data-testid="path-menu-terminal"
            className="text-xs"
            onSelect={() => openAt(folderFor({ path: path.absolute, kind: path.kind }))}
          >
            <SquareTerminal aria-hidden="true" /> Open in terminal
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="path-menu-copy-path"
            className="text-xs"
            onSelect={() => copyOut(path.absolute, 'Path copied')}
          >
            <Copy aria-hidden="true" /> Copy path
          </DropdownMenuItem>
          {/* The path an agent working in that checkout knows the file by, and
              the one a reader pastes into a command they are about to run
              there. Nothing to be relative to outside a checkout, so it greys. */}
          <DropdownMenuItem
            data-testid="path-menu-copy-relative-path"
            className="text-xs"
            disabled={!inside}
            onSelect={() => copyOut(relativeToRoot(path.root ?? '', path.absolute), 'Relative path copied')}
          >
            <Copy aria-hidden="true" /> Copy relative path
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="path-menu-copy-reference"
            className="text-xs"
            onSelect={() => copyOut(referenceOf(path), 'Reference copied')}
          >
            <Quote aria-hidden="true" /> Copy reference
          </DropdownMenuItem>
          {/* Nothing at all for a path outside every checkout: there would be no
              checkout to confine the call to (`file-actions.tsx`). */}
          {actions.items(inside ? { root: path.root!, path: path.absolute, kind: path.kind } : null)}
        </>
      );
    },
    [open, openAt, actions],
  );

  return { items, dialogs: actions.dialogs };
}
