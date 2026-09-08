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
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import { Copy, ExternalLink, Files, FolderOpen, Quote } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/hooks/use-toast';
import { addressWith } from '@/lib/address';
import * as api from '@/lib/api';
import { openLocalPath } from '@/workbench/open-local-path';
import { chipUnder, targetOf, openPathClicked, type OpenPath, type PathHow, type PathTarget } from '@/workbench/path-chip';
import { formatReference } from '@/workbench/references';

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

/** The reference a reader would paste back into a chat for this file. */
export function referenceFor(target: PathTarget, checkouts: string[]): string {
  const root = checkoutOf(target.absolute, checkouts);
  // Relative to its checkout, because that is the path the agent working in
  // that checkout knows the file by; absolute only when it belongs to no
  // checkout of ours and there is nothing to make it relative to.
  const inside = root === null ? '' : target.absolute.slice(root.length + 1);
  return formatReference({
    path: inside || target.absolute,
    line: target.line,
    endLine: target.endLine,
    kind: 'file',
  });
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

/** Put something on the clipboard and say so, since nothing on screen moves. */
function copyOut(text: string, said: string): void {
  const done = navigator.clipboard?.writeText(text);
  if (done) void done.then(() => toast({ title: said }));
}

/** Where a menu was asked for, and what it was asked about. */
interface Asked {
  x: number;
  y: number;
  target: PathTarget;
}

/**
 * The menu behind a right-click on a path: everywhere this app could send it.
 *
 * It hangs off a point rather than off the chip, because the chips are drawn
 * two different ways — one of them painted into a string of HTML, with no
 * component to wrap — and a menu anchored to the pointer works for both without
 * either of them knowing a menu exists.
 */
function PathMenu({ asked, onClose }: { asked: Asked; onClose: () => void }) {
  const checkouts = useCheckouts();
  const open = useOpenPath();
  const ours = insideCheckout(asked.target.absolute, checkouts);
  return (
    <DropdownMenu open modal={false} onOpenChange={(now) => { if (!now) onClose(); }}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden="true" style={{ position: 'fixed', left: asked.x, top: asked.y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={0} className="w-56" data-testid="path-menu">
        {/* Greyed rather than hidden for a file outside the project: the reader
            asked where this path can go, and "not into the Files tab" is part
            of the answer. */}
        <DropdownMenuItem data-testid="path-menu-files" disabled={!ours} onSelect={() => open(asked.target, 'files')}>
          <Files aria-hidden="true" /> Open in Files
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="path-menu-editor" onSelect={() => open(asked.target, 'editor')}>
          <ExternalLink aria-hidden="true" /> Open in editor
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="path-menu-reveal" onSelect={() => open(asked.target, 'reveal')}>
          <FolderOpen aria-hidden="true" /> Reveal in file manager
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="path-menu-copy-path"
          onSelect={() => copyOut(asked.target.absolute, 'Path copied')}
        >
          <Copy aria-hidden="true" /> Copy path
        </DropdownMenuItem>
        {/* `formatReference` and never a hand-built `@a.ts:3-9`: one grammar for
            references, wherever one is produced (`references.ts`). */}
        <DropdownMenuItem
          data-testid="path-menu-copy-reference"
          onSelect={() => copyOut(referenceFor(asked.target, checkouts), 'Reference copied')}
        >
          <Quote aria-hidden="true" /> Copy reference
        </DropdownMenuItem>
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
    menu: asked && <PathMenu asked={asked} onClose={() => setAsked(null)} />,
  };
}
