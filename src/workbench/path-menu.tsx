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

import {
  useCallback,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { Copy, ExternalLink, Files, FolderOpen, Quote, SquareTerminal } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/hooks/use-toast';
import {
  FILE_ACTION_ITEMS,
  folderFor,
  useFileActions,
  type FileActions,
  type PathMoved,
} from '@/workbench/file-actions';
import { PointerAnchor } from '@/workbench/menu-anchor';
import { checkoutOf, useCheckouts, useOpenPath } from '@/workbench/open-path';
import { chipUnder, openPathClicked, targetOf, type PathTarget } from '@/workbench/path-chip';
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


/** Where a menu was asked for, and what it was asked about. */
interface Asked {
  x: number;
  y: number;
  target: PathTarget;
}

/**
 * The menu behind a right-click on a path named in a chat, a card field or a
 * comment.
 *
 * It hangs off a point rather than off the chip, because the chips are drawn
 * two different ways — one of them painted into a string of HTML, with no
 * component to wrap — and a menu anchored to the pointer works for both without
 * either of them knowing a menu exists.
 *
 * What it OFFERS is not written here. It is `items` above, which is also what
 * the Files tree draws (`file-tree.tsx`), so a reader who learns this menu is
 * not wrong at the other one (bw-wk5u.2). A chip always names a file — a folder
 * is opened, never chipped — and the checkout it belongs to is looked up here
 * because only this side of the app has been told what the checkouts are.
 */
function ChipMenu({ asked, menu, onClose }: { asked: Asked; menu: PathMenuItems; onClose: () => void }) {
  const checkouts = useCheckouts();
  return (
    <DropdownMenu open modal={false} onOpenChange={(now) => { if (!now) onClose(); }}>
      {/* Portalled, or the two numbers a pointer gave would be read against
          whichever transformed ancestor happens to be over this chip rather
          than against the viewport (`menu-anchor.tsx`, bw-5gax.1). A chip is
          drawn in a chat, in a card field and in a comment, so there is no one
          ancestor to check — the anchor simply leaves. */}
      <PointerAnchor at={{ left: asked.x, top: asked.y }} />
      <DropdownMenuContent align="start" side="bottom" sideOffset={0} className="w-56" data-testid="path-menu">
        {menu.items({
          absolute: asked.target.absolute,
          root: checkoutOf(asked.target.absolute, checkouts),
          kind: 'file',
          line: asked.target.line,
          endLine: asked.target.endLine,
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How long a finger has to stay put before it counts as a right-click. */
const HELD_LONG_ENOUGH = 500;

/** What a box full of chips puts on itself, and the menu it draws beside it. */
export interface PathActions {
  /** Spread onto the box that holds the chips. */
  chips: {
    onClickCapture: (event: ReactMouseEvent) => void;
    onContextMenu: (event: ReactMouseEvent) => void;
    onPointerDown: (event: ReactPointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onPointerMove: (event: ReactPointerEvent) => void;
  };
  /** Drawn beside the box, once there is a menu to draw. */
  menu: ReactNode;
}

/**
 * Everything a container of file chips needs, in one piece.
 *
 * One set of handlers on the box rather than a handler per chip: that is the
 * arrangement the click already used (bw-khe.13), and the menu joins it so a
 * chip painted into a string of HTML gets the same menu as a chip drawn as a
 * component. A right-click that did not land on a chip is left entirely alone,
 * so the browser's own menu — and the diff's copy-on-selection over it
 * (bw-gr8y.8) — carry on as before.
 */
export function usePathActions(): PathActions {
  const open = useOpenPath();
  const [asked, setAsked] = useState<Asked | null>(null);
  // Held out here rather than inside `ChipMenu`: choosing an item closes the
  // menu, which unmounts `ChipMenu` — and a dialog living inside it would go
  // with it before the reader had typed a letter.
  const menu = usePathMenuItems();
  const held = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where the finger went down, so a scroll can be told from a press. */
  const from = useRef<{ x: number; y: number } | null>(null);

  const letGo = useCallback(() => {
    from.current = null;
    if (held.current === null) return;
    clearTimeout(held.current);
    held.current = null;
  }, []);

  const onClickCapture = useCallback(
    (event: ReactMouseEvent) => {
      openPathClicked(event, open);
    },
    [open],
  );

  const onContextMenu = useCallback((event: ReactMouseEvent) => {
    const chip = chipUnder(event.target);
    if (!chip) return;
    event.preventDefault();
    event.stopPropagation();
    setAsked({ x: event.clientX, y: event.clientY, target: targetOf(chip) });
  }, []);

  // A touch has no second button, so it says the same thing by staying still.
  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      letGo();
      if (event.pointerType === 'mouse') return;
      const chip = chipUnder(event.target);
      if (!chip) return;
      const { clientX: x, clientY: y } = event;
      const target = targetOf(chip);
      from.current = { x, y };
      held.current = setTimeout(() => {
        held.current = null;
        setAsked({ x, y, target });
      }, HELD_LONG_ENOUGH);
    },
    [letGo],
  );

  // A finger that wandered is a scroll, not a press. A few pixels of wobble is
  // a finger holding still, so the press survives that and nothing more.
  const moved = useCallback(
    (event: ReactPointerEvent) => {
      const start = from.current;
      if (start === null) return;
      if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 10) letGo();
    },
    [letGo],
  );

  return {
    chips: {
      onClickCapture,
      onContextMenu,
      onPointerDown,
      onPointerUp: letGo,
      onPointerCancel: letGo,
      onPointerMove: moved,
    },
    menu: (
      <>
        {asked && <ChipMenu asked={asked} menu={menu} onClose={() => setAsked(null)} />}
        {menu.dialogs}
      </>
    ),
  };
}
