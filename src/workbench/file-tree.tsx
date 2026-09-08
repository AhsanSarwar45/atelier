'use client';

/**
 * The project's files, as a tree (bw-g3o3.12).
 *
 * The rules it is built on, and why each one is there:
 *
 * - **One level at a time.** A directory is read when it is opened and never
 *   before. A checkout here holds a `node_modules` and a `target`; walking the
 *   whole thing to draw the six rows a reader can see would be minutes of
 *   stat calls for nothing, and the answer would be stale by the time it
 *   arrived. `api.fs.tree` reads exactly one level (bw-g3o3.2).
 * - **Only the rows on screen exist.** A folder of five thousand files is an
 *   ordinary thing, and five thousand DOM rows is a tab that stutters when it
 *   scrolls. The flattening below turns the open folders into one list and
 *   `@tanstack/react-virtual` mounts the slice of it the reader is looking at.
 * - **The drawing follows the disk.** A file written from a terminal, by an
 *   agent or by a build shows up without a click, through `useFolderReads`
 *   (bw-g3o3.3), which re-reads only the directories that actually moved.
 * - **Ignored is dimmed, not hidden — until a reader says otherwise.** The
 *   server flags what git ignores rather than dropping it, because "where did
 *   my build output go" is a worse question than a dim row.
 * - **The address is the selection.** Clicking a file writes `file=` into the
 *   address, which is what the viewer reads. Nothing about which file is open
 *   lives in this component.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';

import { FileIcon } from '@/components/file-icon';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { git, fs as fsApi, type FsTreeEntry, type GitStatus } from '@/lib/api';
import { STATUS_LOOK, type FileState } from '@/workbench/git-view';
import { useFolderReads } from '@/workbench/use-folder-reads';
import { useRepositoryReads } from '@/workbench/use-repository-reads';

/** How tall one row is, in px. Fixed, so the virtualiser never measures. */
export const ROW_HEIGHT = 22;

/** Rows kept mounted just outside the viewport, so a flick shows no gaps. */
export const OVERSCAN = 12;

/** How far one level of nesting steps in, in px. */
export const INDENT = 12;

/** Whether ignored files are hidden. One answer for every project. */
export const HIDE_IGNORED = 'workbench.files-hide-ignored';

/**
 * The tone each git state paints a name in.
 *
 * The states and their tones are the Git rail's (`STATUS_LOOK`), read straight
 * out of it rather than copied: a tree that invented its own palette would have
 * a file green in one panel and blue in another, and only one of them would get
 * fixed when the palette moved.
 */
const TONE_CLASS: Record<(typeof STATUS_LOOK)[FileState]['tone'], string> = {
  success: 'text-success',
  warning: 'text-warning',
  info: 'text-info',
  destructive: 'text-destructive',
};

/** One row of the flattened tree: an entry, and how deep it is drawn. */
export interface TreeRow {
  entry: FsTreeEntry;
  depth: number;
  /** True for a directory whose contents are being drawn under it. */
  open: boolean;
}

/**
 * The open folders, flattened into the list the virtualiser scrolls.
 *
 * `read` holds one level per directory that has been read. A directory that is
 * open but not yet read contributes no children, which is exactly right: the
 * chevron turns and the rows arrive a moment later, rather than the row sitting
 * shut until the answer comes.
 */
export function rowsOf(
  read: ReadonlyMap<string, FsTreeEntry[]>,
  root: string,
  open: ReadonlySet<string>,
  showIgnored: boolean,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of read.get(dir) ?? []) {
      if (entry.ignored && !showIgnored) continue;
      const isOpen = entry.kind === 'dir' && open.has(entry.path);
      rows.push({ entry, depth, open: isOpen });
      if (isOpen) walk(entry.path, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/**
 * What git says about each file, by absolute path.
 *
 * A file can be in two of git's lists at once — picked, then edited again — so
 * the order here is the order a reader cares about: a conflict first, then what
 * the file says on disk against what was picked, then what was picked, then a
 * file git has never heard of.
 */
export function statusByPath(status: GitStatus, root: string): Map<string, FileState> {
  const by = new Map<string, FileState>();
  const at = (relative: string) => `${root.replace(/\/+$/, '')}/${relative}`;
  for (const file of status.untracked) by.set(at(file.path), 'untracked');
  for (const change of status.staged) by.set(at(change.path), change.status);
  for (const change of status.unstaged) by.set(at(change.path), change.status);
  for (const file of status.conflicted) by.set(at(file.path), 'conflicted');
  return by;
}

/**
 * Every directory between `root` and `file`, outermost first.
 *
 * This is what "reveal the selected file" needs: each one has to be opened, and
 * read, before the one below it can be. A file that is not under the root at
 * all names nothing, which is the honest answer for a link into another
 * checkout.
 */
export function ancestorsOf(root: string, file: string): string[] {
  const base = root.replace(/\/+$/, '');
  if (!file.startsWith(`${base}/`)) return [];
  const parts = file.slice(base.length + 1).split('/');
  return parts.slice(0, -1).map((_, index) => `${base}/${parts.slice(0, index + 1).join('/')}`);
}

/** The directory a path is in. */
function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

export interface FileTreeProps {
  /** The checkout being drawn. Null while the tab is still choosing one. */
  root: string | null;
  /** The file the address names, absolute, or null when it names none. */
  selected: string | null;
  /** Called with an absolute path when a file is opened. */
  onOpen: (path: string) => void;
}

export default function FileTree({ root, selected, onOpen }: FileTreeProps) {
  const [read, setRead] = useState<ReadonlyMap<string, FsTreeEntry[]>>(new Map());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [showIgnored, setShowIgnored] = useState(true);
  const [status, setStatus] = useState<Map<string, FileState>>(new Map());
  /** The row the arrow keys are standing on. Not the same as the open file. */
  const [cursor, setCursor] = useState<string | null>(null);
  const pane = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShowIgnored(localStorage.getItem(HIDE_IGNORED) !== '1');
  }, []);

  // A new root is a different tree entirely: everything read, opened and
  // pointed at belonged to the checkout before it.
  useEffect(() => {
    setRead(new Map());
    setOpen(new Set());
    setCursor(null);
    setStatus(new Map());
  }, [root]);

  /**
   * Read one level and keep it. Handed the directory rather than reading
   * whatever is open, so the caller decides how much work a change is worth.
   */
  const readLevel = useCallback(async (dir: string) => {
    try {
      const answer = await fsApi.tree(dir);
      setRead((had) => new Map(had).set(dir, answer.entries));
    } catch {
      // A folder deleted from under us, or one we may not read. An empty level
      // is the truthful drawing of both, and it replaces whatever was there.
      setRead((had) => new Map(had).set(dir, []));
    }
  }, []);

  /**
   * The disk moved. Only the directories being drawn are re-read, and when the
   * signal names paths, only the directories those paths are in — the whole
   * reason the watcher carries names (bw-g3o3.3).
   */
  const follow = useCallback(
    async (moved: string[]) => {
      if (!root) return;
      const drawn = new Set([root, ...open]);
      const wanted = moved.length === 0
        ? [...drawn]
        : [...new Set(moved.map(directoryOf))].filter((dir) => drawn.has(dir));
      await Promise.all(wanted.map(readLevel));
    },
    [root, open, readLevel],
  );

  // Nothing here asks for a read of its own, so the handle back is not kept.
  useFolderReads(root, follow);

  // The root's own level, as soon as there is a root.
  useEffect(() => {
    if (root) void readLevel(root);
  }, [root, readLevel]);

  // Git's answer, kept current the way every other panel drawn from a
  // repository keeps its own: the watch on the git directory, plus the slow
  // look for an edit no watcher can see.
  const readStatus = useCallback(async () => {
    if (!root) return;
    try {
      setStatus(statusByPath(await git.status(root), root));
    } catch {
      // No repository, or git would not answer. Names go uncoloured, which is
      // what a folder that is not a checkout should look like anyway.
      setStatus(new Map());
    }
  }, [root]);
  useRepositoryReads(root, readStatus);
  useEffect(() => {
    void readStatus();
  }, [readStatus]);

  const rows = useMemo(
    () => (root ? rowsOf(read, root, open, showIgnored) : []),
    [read, root, open, showIgnored],
  );

  const expand = useCallback(
    (dir: string) => {
      setOpen((had) => new Set(had).add(dir));
      if (!read.has(dir)) void readLevel(dir);
    },
    [read, readLevel],
  );

  const collapse = useCallback((dir: string) => {
    setOpen((had) => {
      const next = new Set(had);
      next.delete(dir);
      return next;
    });
  }, []);

  const toggle = useCallback(
    (row: TreeRow) => (row.open ? collapse(row.entry.path) : expand(row.entry.path)),
    [collapse, expand],
  );

  const choose = useCallback(
    (row: TreeRow) => {
      setCursor(row.entry.path);
      if (row.entry.kind === 'dir') toggle(row);
      else onOpen(row.entry.path);
    },
    [onOpen, toggle],
  );

  /**
   * Open every folder above the selected file, and read each one.
   *
   * A link straight into a file lands on a tree showing only the root, and the
   * file is six folders down. Each level has to be read before the next can be
   * asked for, so this walks down rather than opening them all at once.
   */
  useEffect(() => {
    if (!root || !selected) return;
    const ancestors = ancestorsOf(root, selected);
    if (ancestors.length === 0) return;
    setOpen((had) => {
      const next = new Set(had);
      for (const dir of ancestors) next.add(dir);
      return next;
    });
    // The first ancestor whose level is missing, and only that one: reading it
    // re-runs this effect, which asks for the next.
    const missing = ancestors.find((dir) => !read.has(dir));
    if (missing && read.has(directoryOf(missing))) void readLevel(missing);
  }, [root, selected, read, readLevel]);

  // The cursor follows the address, so the arrows carry on from the file that
  // was opened rather than from wherever they were last left.
  useEffect(() => {
    if (selected) setCursor(selected);
  }, [selected]);

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => pane.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]!.entry.path,
    overscan: OVERSCAN,
  });

  // The selected row scrolled into view once its folder has been opened. Held
  // by path, so a re-read that shifts every index does not scroll again.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || revealed.current === selected) return;
    const index = rows.findIndex((row) => row.entry.path === selected);
    if (index === -1) return;
    revealed.current = selected;
    virtual.scrollToIndex(index, { align: 'auto' });
  }, [selected, rows, virtual]);

  const move = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const index = rows.findIndex((row) => row.entry.path === cursor);
      const row = index === -1 ? null : rows[index];
      const stand = (next: number) => {
        const landing = rows[Math.max(0, Math.min(rows.length - 1, next))];
        if (!landing) return;
        setCursor(landing.entry.path);
        virtual.scrollToIndex(rows.indexOf(landing), { align: 'auto' });
      };
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          stand(index === -1 ? 0 : index + 1);
          return;
        case 'ArrowUp':
          event.preventDefault();
          stand(index === -1 ? 0 : index - 1);
          return;
        case 'ArrowRight':
          event.preventDefault();
          if (!row) return stand(0);
          // A shut folder opens; an open one steps into what it holds. A file
          // has nothing to the right of it, so the cursor stays put.
          if (row.entry.kind === 'dir' && !row.open) expand(row.entry.path);
          else if (row.open) stand(index + 1);
          return;
        case 'ArrowLeft': {
          event.preventDefault();
          if (!row) return;
          // An open folder shuts. Anything else steps out to the folder it is
          // in, which is the nearest row above it that is one level shallower.
          if (row.open) return collapse(row.entry.path);
          for (let above = index - 1; above >= 0; above -= 1) {
            if (rows[above]!.depth < row.depth) return stand(above);
          }
          return;
        }
        case 'Enter':
        case ' ':
          event.preventDefault();
          if (row) choose(row);
          return;
        default:
      }
    },
    [rows, cursor, expand, collapse, choose, virtual],
  );

  const flipIgnored = useCallback(() => {
    setShowIgnored((shown) => {
      localStorage.setItem(HIDE_IGNORED, shown ? '1' : '0');
      return !shown;
    });
  }, []);

  if (!root) return <div className="min-h-0 flex-1" data-testid="files-tree" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="files-tree">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/40 px-2 py-1">
        <span className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
          {root.slice(root.lastIndexOf('/') + 1)}
        </span>
        <Tooltip label={showIgnored ? 'Hide ignored files' : 'Show ignored files'}>
          <Button
            size="xs"
            mode="icon"
            variant="ghost"
            data-testid="files-ignored-toggle"
            data-showing={showIgnored ? 'yes' : 'no'}
            aria-pressed={showIgnored}
            aria-label={showIgnored ? 'Hide ignored files' : 'Show ignored files'}
            onClick={flipIgnored}
          >
            {showIgnored ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
          </Button>
        </Tooltip>
      </div>

      {/*
        The scroller is what takes the keys: one tab stop for the whole tree,
        the way a tree is meant to work, rather than five thousand of them.
      */}
      <div
        ref={pane}
        role="tree"
        aria-label="Project files"
        tabIndex={0}
        onKeyDown={move}
        data-testid="files-tree-scroller"
        className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <div
          className="relative w-full"
          data-testid="files-tree-row-list"
          style={{ height: `${virtual.getTotalSize()}px` }}
        >
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            const { entry } = row;
            const state = status.get(entry.path);
            const tone = state ? TONE_CLASS[STATUS_LOOK[state].tone] : '';
            const chosen = entry.path === selected;
            return (
              <div
                key={item.key}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={chosen}
                aria-expanded={entry.kind === 'dir' ? row.open : undefined}
                data-testid="files-tree-row"
                data-path={entry.path}
                data-kind={entry.kind}
                data-depth={row.depth}
                data-ignored={entry.ignored ? 'yes' : undefined}
                data-status={state ?? undefined}
                data-cursor={entry.path === cursor ? 'yes' : undefined}
                onClick={() => choose(row)}
                style={{ height: `${ROW_HEIGHT}px`, transform: `translateY(${item.start}px)` }}
                className={[
                  'absolute inset-x-0 top-0 flex cursor-pointer select-none items-center pr-2 text-[13px]',
                  chosen ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/60',
                  entry.ignored ? 'opacity-45' : '',
                ].join(' ')}
              >
                {/* The indent guides: one hairline per level crossed, drawn as
                    the left edge of a spacer rather than a background image, so
                    they line up with the chevron whatever the row holds. */}
                {Array.from({ length: row.depth }, (_, level) => (
                  <span
                    key={level}
                    aria-hidden="true"
                    data-testid="files-tree-guide"
                    className="h-full shrink-0 border-l border-border/40"
                    style={{ width: `${INDENT}px` }}
                  />
                ))}
                <span className="flex h-full w-4 shrink-0 items-center justify-center">
                  {entry.kind === 'dir'
                    ? (row.open
                        ? <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                        : <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />)
                    : null}
                </span>
                <FileIcon name={entry.name} kind={entry.kind} open={row.open} />
                <span className={`ml-1.5 truncate ${tone}`}>{entry.name}</span>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="files-tree-empty">
            Nothing to show
          </p>
        )}
      </div>
    </div>
  );
}
