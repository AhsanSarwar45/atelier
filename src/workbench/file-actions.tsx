'use client';

/**
 * What the app can DO to a file, as opposed to where it can open it (bw-5gax).
 *
 * The Files tab could read a project and never change it: the tree's only
 * right-click item was Copy reference. That is not a file manager, and this app
 * is meant to be a whole coding environment rather than a reader that sends
 * people out to one — so renaming, deleting, creating and duplicating live
 * here.
 *
 * ## One list, two menus
 *
 * There are two pointer menus over paths in this app: the tree's own
 * (`file-tree.tsx`) and the one behind every path chip in a chat, a card field
 * or a comment (`open-path.tsx`). Two menus that disagree about what can be
 * done to a file is a worse fault than either menu being short, because the
 * reader learns one of them and is then wrong somewhere else. So the items are
 * built once, here, and both menus ask for them.
 *
 * ## Only inside a checkout
 *
 * Every operation names the checkout it is working in, and the server proves
 * the path is inside it before touching anything (`routes/fs.rs`). The client
 * asking is not the guard — it decides only whether to OFFER the item, which is
 * why a chip pointing at `/etc/hosts` gets no operations at all: there is no
 * checkout to confine them to.
 *
 * ## What follows a file that moved
 *
 * A rename is not only a call: the file may be open in the viewer, named in the
 * address and sitting in the strip of open files. `onMoved` is how the screen
 * that owns those is told, so a file open under one name stays open under the
 * next one rather than the reader being dropped onto "Pick a file".
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Copy, FilePlus2, FolderPlus, Pencil, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import { fs } from '@/lib/api';
import { isUnsaved } from '@/workbench/unsaved-files';

/** A path an operation can be aimed at, with the checkout that confines it. */
export interface PathInCheckout {
  /** The checkout the path lives in, absolute. */
  root: string;
  /** The path itself, absolute. */
  path: string;
  /** What is there. A folder's contents move with it. */
  kind: 'file' | 'dir';
}

/**
 * Told that a path became another path, or became nothing.
 *
 * `to` is null when the path is gone. A folder is reported as itself: whatever
 * is holding open files works out which of them were inside it, because it is
 * the thing that knows what it has open.
 */
export type PathMoved = (from: string, to: string | null) => void;

/** The last segment of a path — the part a rename box holds. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * How much of a name is a rename box's first selection: everything up to the
 * extension.
 *
 * Renaming a file almost always means keeping the extension, and a box that
 * selects the whole of `survivor-concept.png` makes the reader put `.png` back
 * by hand every time. A dotfile is all name (`.gitignore`), which is why a dot
 * at position zero is not an extension.
 */
export function stemLength(name: string): number {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}

/** What is being asked for, and about what. */
interface Asked {
  what: 'rename' | 'delete' | 'new-file' | 'new-folder';
  target: PathInCheckout;
}

/** Whether an ask is one of the two that put a new name in a folder. */
function makesSomething(what: Asked['what']): boolean {
  return what === 'new-file' || what === 'new-folder';
}

/**
 * The folder a new thing goes in: the row itself when it is a folder, and the
 * folder the row is in when it is a file.
 *
 * Which is what a reader means by right-clicking. A new file asked for while
 * pointing at `src/main.ts` belongs beside `main.ts`, not at the top of the
 * checkout — and one asked for while pointing at `src/` belongs inside it.
 */
export function folderFor(target: PathInCheckout): string {
  return target.kind === 'dir' ? target.path : target.path.slice(0, target.path.lastIndexOf('/'));
}

/** What the menus get: the items to draw, and the dialogs to stand beside them. */
export interface FileActions {
  /** The items for one path, or nothing when it is outside every checkout. */
  items: (target: PathInCheckout | null) => ReactNode;
  /** Mounted once beside whichever menu drew the items. */
  dialogs: ReactNode;
}

/** Say a call failed, in the words the server used where it gave any. */
function refused(what: string, why: unknown): void {
  toast({
    title: what,
    description: why instanceof Error ? why.message : undefined,
    variant: 'destructive',
  });
}

/**
 * The one set of things that can be done to a path, for whichever menu asks.
 *
 * `onMoved` is optional because only the screen that holds open files has an
 * answer for it; a chip in a chat changes the same disk and simply has nothing
 * of its own to carry.
 */
export function useFileActions(onMoved?: PathMoved, onMade?: (path: string) => void): FileActions {
  const [asked, setAsked] = useState<Asked | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  // The name up to the extension, selected the moment the box appears: that is
  // the part being changed, and it saves typing `.png` back every time. A new
  // thing starts empty, so there is nothing to select.
  useEffect(() => {
    if (asked === null || asked.what === 'delete') return;
    const there = box.current;
    if (!there) return;
    there.focus();
    there.setSelectionRange(0, stemLength(there.value));
  }, [asked]);

  const ask = useCallback((what: Asked['what'], target: PathInCheckout) => {
    setName(makesSomething(what) ? '' : nameOf(target.path));
    setAsked({ what, target });
  }, []);

  const remove = useCallback(async () => {
    if (asked === null || busy) return;
    const { root, path } = asked.target;
    setBusy(true);
    try {
      await fs.remove(root, path);
      setAsked(null);
      onMoved?.(path, null);
      // Said out loud, because the row simply vanishes and "where did it go" is
      // exactly the question this answers.
      toast({ title: `${nameOf(path)} moved to Trash` });
    } catch (why: unknown) {
      refused('That could not be deleted', why);
    } finally {
      setBusy(false);
    }
  }, [asked, busy, onMoved]);

  /**
   * Copy something beside itself. No dialog: the server picks the first free
   * `… copy` name and hands it back, and the toast says which — a duplicate is
   * made to be edited, and its real name is whatever the editing turns it into.
   */
  const duplicate = useCallback(async (target: PathInCheckout) => {
    try {
      const answer = await fs.duplicate(target.root, target.path);
      toast({ title: `Copied to ${nameOf(answer.path)}` });
    } catch (why: unknown) {
      refused('That could not be duplicated', why);
    }
  }, []);

  /** The one submit behind the box: renaming, or making a new file or folder. */
  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (asked === null || busy) return;
      if (makesSomething(asked.what)) {
        setBusy(true);
        try {
          const kind = asked.what === 'new-folder' ? 'dir' : 'file';
          const answer = await fs.create(asked.target.root, folderFor(asked.target), name, kind);
          setAsked(null);
          // A new FILE opens: it is empty, and the only reason to make one is to
          // put something in it. A new folder does not, because there is nothing
          // in it to look at.
          if (kind === 'file') onMade?.(answer.path);
        } catch (why: unknown) {
          refused('That could not be created', why);
        } finally {
          setBusy(false);
        }
        return;
      }
      const { root, path } = asked.target;
      // An unsaved edit lives in the viewer, keyed by the path it was typed
      // into. Renaming underneath it would leave the reader looking at a file
      // whose changes belong to a name that no longer exists, so the rename is
      // refused rather than the work being quietly dropped.
      if (isUnsaved(path)) {
        refused('Save your changes first', new Error(`${nameOf(path)} has edits that have not been saved.`));
        return;
      }
      setBusy(true);
      try {
        const answer = await fs.rename(root, path, name);
        setAsked(null);
        onMoved?.(path, answer.path);
      } catch (why: unknown) {
        refused('That could not be renamed', why);
      } finally {
        setBusy(false);
      }
    },
    [asked, busy, name, onMade, onMoved],
  );

  const items = useCallback(
    (target: PathInCheckout | null) => {
      if (target === null) return null;
      return (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="path-new-file"
            className="text-xs"
            onSelect={() => ask('new-file', target)}
          >
            <FilePlus2 aria-hidden="true" /> New file…
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="path-new-folder"
            className="text-xs"
            onSelect={() => ask('new-folder', target)}
          >
            <FolderPlus aria-hidden="true" /> New folder…
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="path-duplicate"
            className="text-xs"
            onSelect={() => void duplicate(target)}
          >
            <Copy aria-hidden="true" /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="path-rename"
            className="text-xs"
            onSelect={() => ask('rename', target)}
          >
            <Pencil aria-hidden="true" /> Rename…
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="path-delete"
            className="text-xs text-destructive focus:text-destructive"
            onSelect={() => ask('delete', target)}
          >
            <Trash2 aria-hidden="true" /> Move to Trash…
          </DropdownMenuItem>
        </>
      );
    },
    [ask, duplicate],
  );

  const dialogs = (
    <Dialog open={asked !== null} onOpenChange={(open) => { if (!open) setAsked(null); }}>
      {asked?.what === 'delete' ? (
        // A decision to be answered rather than a form to fill in, so it is
        // announced as one — built out of the app's own dialog, the way the Git
        // rail's confirmation is (`git-view.tsx`). `alert-dialog.tsx` is
        // reached by nothing in the app and asks for theme variables no theme
        // defines, so it would draw its dim in an invalid colour.
        <DialogContent
          role="alertdialog"
          className="w-[90vw] gap-3 sm:max-w-md"
          data-testid="path-delete-dialog"
        >
          <DialogHeader>
            <DialogTitle>Move {asked.target.kind === 'dir' ? 'folder' : 'file'} to Trash?</DialogTitle>
            {/* Where it goes, in the sentence the reader answers — not in a
                toast afterwards. This is the only call in the app that cannot
                be undone from inside it, so what "delete" means here is said
                out loud: the desktop's trash, restorable from the file manager,
                and a folder takes everything in it. */}
            <DialogDescription className="break-words">
              {nameOf(asked.target.path)}
              {asked.target.kind === 'dir' ? ', and everything in it,' : ''} goes to your desktop&apos;s
              Trash. Nothing is erased — you can put it back from your file manager. Atelier itself
              cannot undo this.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" disabled={busy} data-testid="path-delete-cancel" onClick={() => setAsked(null)}>
              Keep
            </Button>
            <Button variant="destructive" disabled={busy} data-testid="path-delete-confirm" onClick={() => void remove()}>
              Move to Trash
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : (
      // One box for all three, because they are one question — what is this
      // called — asked about a name that exists or one that does not yet.
      <DialogContent className="sm:max-w-md" data-testid="path-name-dialog">
        <DialogHeader>
          <DialogTitle>
            {asked?.what === 'new-file' ? 'New file' : null}
            {asked?.what === 'new-folder' ? 'New folder' : null}
            {asked?.what === 'rename' ? `Rename ${asked.target.kind === 'dir' ? 'folder' : 'file'}` : null}
          </DialogTitle>
          <DialogDescription className="break-words">
            {asked === null
              ? ''
              : makesSomething(asked.what)
                ? `In ${nameOf(folderFor(asked.target)) || folderFor(asked.target)}.`
                : `${nameOf(asked.target.path)} stays in the folder it is in; only its name changes.`}
          </DialogDescription>
        </DialogHeader>
        {/* A form, so Enter finishes it — a name box that needs the mouse is a
            name box nobody uses twice. */}
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Input
            ref={box}
            value={name}
            spellCheck={false}
            autoComplete="off"
            aria-label="Name"
            placeholder={asked?.what === 'new-folder' ? 'components' : 'notes.md'}
            data-testid="path-name"
            onChange={(event) => setName(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAsked(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="path-name-confirm"
              disabled={
                busy ||
                name.trim() === '' ||
                (asked !== null && !makesSomething(asked.what) && name === nameOf(asked.target.path))
              }
            >
              {asked !== null && makesSomething(asked.what) ? 'Create' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      )}
    </Dialog>
  );

  return { items, dialogs };
}
