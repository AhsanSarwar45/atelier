'use client';

/**
 * The Files tab: the project's own files, beside a view of the one being read.
 *
 * This is the room (bw-g3o3.4). What it settles is everything the tree in the
 * rail and the viewer in the centre have to agree about: which checkout the
 * files are being read out of, how wide the rail is, and that both survive a
 * reload. The tree (`file-tree.tsx`) stands in the rail (bw-g3o3.12).
 *
 * The viewer side is the strip of open files and, under it, the file itself:
 * text in CodeMirror (bw-g3o3.17) and everything else as the thing it is
 * (`file-preview.tsx`). Which file is shown stays in the address, so a link
 * still opens exactly what it names; what the strip holds is only which files
 * are open and which of them are pinned, remembered per project so a reader
 * comes back to the set they were working in.
 *
 * Below `md` the rail is not a column at all: it is a sheet over the viewer,
 * with a scrim and a toggle on the bar, exactly as the chat's two rails are
 * (`chat-tab.tsx`, `chat-right-rail.tsx`). A 288px rail beside a 390px screen
 * left the file 102px to be read in — a text file showed a fifth of its line,
 * the Markdown preview drew its heading one letter to a line, and the viewer's
 * own edit/copy/open/reveal buttons were off the right of the pane. That is the
 * complaint this tab was opened on (bw-e3dw.2).
 *
 * The root matters more than it looks. A project with worktrees has the same
 * file at several paths at once, on different branches, and a tree that quietly
 * assumed the project's own checkout would show a reader the wrong copy of the
 * file they were sure they had just edited. So it is a choice, made in the one
 * place the files are shown, and remembered per project.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { PanelLeft } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';

import { TabLead, ToolButton } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Picker } from '@/components/ui/picker';
import { addressWith } from '@/lib/address';
import * as api from '@/lib/api';
import type { GitTree } from '@/lib/api';
import { isPhoneScreen } from '@/lib/screen-width';
import { cn } from '@/lib/utils';
import { FilePreview, PREVIEWS_NEEDING_TEXT, previewKind } from '@/workbench/file-preview';
import FileTree from '@/workbench/file-tree';
import { FileViewer, type ViewedFile } from '@/workbench/file-viewer';
import {
  closing,
  closingCurrent,
  openFilesFrom,
  openFilesKey,
  pinning,
  type OpenFile,
  type OpenFiles,
} from '@/workbench/open-files';
import { OpenFilesStrip } from '@/workbench/open-files-strip';
import { ResizeDivider, DEFAULT_PANEL_WIDTH, rememberedPanelWidth } from '@/workbench/resize-divider';
import { useUnsavedPaths } from '@/workbench/unsaved-files';
import { useFolderReads } from '@/workbench/use-folder-reads';

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
  const router = useRouter();
  const params = useSearchParams();
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [trees, setTrees] = useState<GitTree[]>([]);
  const [remembered, setRemembered] = useState<string | null>(null);

  // Whether the tree is showing. It only decides anything below `md`, where the
  // rail is a sheet; above it the rail is a column and the CSS keeps it drawn
  // whatever this says.
  const [railOpen, setRailOpen] = useState(false);
  // The file the tab was opened on, read once: putting `file` in the effect
  // below would throw the sheet open again on every file the reader picks.
  const openedOn = useRef(file);

  useEffect(() => {
    // A phone that arrived with a file to read starts shut — the sheet would
    // otherwise lie over the very file the address named. A phone that arrived
    // with none starts open, because the alternative is a tab that opens on
    // "Pick a file" with the way to pick one out of sight.
    setRailOpen(!isPhoneScreen() || !openedOn.current);
  }, []);

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

  /**
   * A file picked in the tree goes into the address, never into a state here:
   * the viewer reads it from there, and so does a link somebody pastes to a
   * colleague. The line is dropped, because the line that was right for the
   * file being left is wrong for the one arriving.
   */
  const openFile = useCallback(
    (path: string) => {
      // The sheet's work is done the moment a file is named: left open it would
      // sit over the file it has just opened. Only files come through here —
      // a folder in the tree opens itself and never calls this.
      setRailOpen(false);
      router.push(addressWith(params, { tab: 'files', file: path, line: null }));
    },
    [router, params],
  );

  const chooseRoot = useCallback(
    (next: string) => {
      setRemembered(next);
      localStorage.setItem(filesRootKey(projectId), next);
    },
    [projectId],
  );

  // The strip, tagged with the project it was read for: without the tag, the
  // effect below would write the previous project's open files into the new
  // project's key on the render where `projectId` changes.
  const [strip, setStrip] = useState<{ key: string; files: OpenFile[] }>({ key: '', files: [] });

  useEffect(() => {
    if (!projectId) return;
    const key = openFilesKey(projectId);
    setStrip({ key, files: openFilesFrom(localStorage.getItem(key)) });
  }, [projectId]);

  useEffect(() => {
    if (!projectId || strip.key !== openFilesKey(projectId)) return;
    localStorage.setItem(strip.key, JSON.stringify(strip.files));
  }, [strip, projectId]);

  // The address names the file being read, so a file arriving in it — a pasted
  // link, a path clicked somewhere else in the app — opens in the preview slot,
  // exactly as a single click in the tree will.
  useEffect(() => {
    if (!file) return;
    setStrip((was) => {
      if (was.files.some((open) => open.path === file)) return was;
      const slot = was.files.findIndex((open) => open.preview);
      const opened: OpenFile = { path: file, preview: true };
      return {
        ...was,
        files: slot === -1 ? [...was.files, opened] : was.files.map((open, at) => (at === slot ? opened : open)),
      };
    });
  }, [file]);

  const open: OpenFiles = useMemo(() => ({ files: strip.files, current: file }), [strip.files, file]);

  // The strip's own way of naming a file, beside `openFile` above: the tree
  // pushes, because clicking through a tree is a journey Back should be able
  // to walk; a tab is where the reader already is, so it replaces.
  //
  // `tab` is written every time: dropping the last file from an address that
  // never spelled the tab out would otherwise send the reader to the board.
  const show = useCallback(
    (path: string | null) => router.replace(addressWith(params, { tab: 'files', file: path, line: null })),
    [router, params],
  );

  const applied = useCallback((next: OpenFiles) => {
    setStrip((was) => ({ ...was, files: next.files }));
    if (next.current !== file) show(next.current);
  }, [file, show]);

  const preview = useCallback((path: string) => { if (path !== file) show(path); }, [file, show]);
  const pin = useCallback((path: string) => applied(pinning(open, path)), [applied, open]);
  const close = useCallback((path: string) => applied(closing(open, path)), [applied, open]);
  const closeCurrent = useCallback(() => applied(closingCurrent(open)), [applied, open]);

  // Only the views that read as source need the file's text; a video or a PDF
  // is served straight out of the media route and is never read into the page.
  const kind = file ? previewKind(file) : null;
  const wantsText = kind !== null && PREVIEWS_NEEDING_TEXT.includes(kind);
  const [read, setRead] = useState<{ file: ViewedFile | null; error: string | null }>({ file: null, error: null });

  // Which file the answer being waited on is for. A read started for one file
  // can still land after the reader has clicked on to the next, and without
  // this the second file would be drawn holding the first one's text.
  const wanted = useRef(file);
  wanted.current = file;

  const readFile = useCallback(async () => {
    if (!file || !wantsText) return;
    const asked = file;
    try {
      const answer = await api.fs.read(asked);
      if (wanted.current !== asked) return;
      setRead({
        file: answer.kind === 'text'
          ? { kind: 'text', text: answer.text ?? '', truncated: answer.truncated, size: answer.size, sha256: answer.sha256, mtime: answer.mtime }
          : { kind: 'binary', size: answer.size },
        error: null,
      });
    } catch (why: unknown) {
      if (wanted.current !== asked) return;
      setRead({ file: null, error: why instanceof Error ? why.message : 'This file could not be read.' });
    }
  }, [file, wantsText]);

  // Read once when the file is named, and again whenever its folder moves. Each
  // fresh read is handed to the viewer, which decides what it means: nothing
  // typed yet and the text takes; something typed and the reader is asked
  // (`use-file-edits.ts`). This is what makes a file written from a terminal
  // show up here without a reload, and what makes a save settle.
  const folder = file ? file.slice(0, file.lastIndexOf('/')) : null;
  const readAgain = useFolderReads(wantsText ? folder : null, readFile);

  useEffect(() => {
    // A different file, and nothing of the last one left on screen while the
    // new one is being fetched.
    setRead({ file: null, error: null });
    void readAgain();
  }, [readAgain]);

  // The dots on the strip and the window's "are you sure" are drawn from the
  // one store the viewer marks (`unsaved-files.ts`), so a keystroke into the
  // file being edited does not redraw every tab.
  const unsaved = useUnsavedPaths();
  const dirty = useMemo(() => new Set(unsaved), [unsaved]);

  return (
    // `relative`, because on a phone the rail and its scrim are drawn inside
    // this box rather than over the window: a sheet that covered the bar would
    // bury the toggle that opens it (bw-e3dw.9).
    <div className="relative flex min-h-0 flex-1" data-testid="files-tab" data-root={root ?? undefined}>
      {/* First on the row, ahead of the tab selector: the way into the tree
          opens a whole pane rather than acting on the one already on screen,
          which is why the chat's own [chat-rail-toggle] sits here too
          (bw-81wt.5). Gone above `md`, where the tree is simply there. */}
      <TabLead tab="files">
        <ToolButton
          icon={<PanelLeft />}
          label={railOpen ? 'Hide the file tree' : 'Show the file tree'}
          emphasis={railOpen ? 'loud' : 'quiet'}
          className="md:hidden"
          data-testid="files-rail-toggle"
          data-open={railOpen}
          onClick={() => setRailOpen((showing) => !showing)}
        />
      </TabLead>
      <div
        data-testid="files-rail"
        data-open={railOpen}
        style={{ '--files-rail-width': `${width}px` } as CSSProperties}
        className={cn(
          // On a phone a sheet from the left edge, filling what the bars left
          // over and taking no width from the viewer, which is what a file is
          // read in. On a wide screen the column it has always been, its width
          // the one the divider drags.
          'z-50 flex h-full shrink-0 flex-col border-r border-border/40 bg-background transition-transform md:relative md:z-30 md:translate-x-0',
          'absolute inset-y-0 left-0 w-72 max-w-[85vw] md:w-[var(--files-rail-width)]',
          railOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full',
        )}
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
        <div className="flex min-h-0 flex-1 flex-col" data-testid="files-tree-slot">
          <FileTree root={root} selected={file} onOpen={openFile} />
        </div>
      </div>
      <ResizeDivider
        side="left"
        value={width}
        onChange={changeWidth}
        maximum={() => (typeof window === 'undefined' ? Infinity : window.innerWidth - MIN_VIEWER_WIDTH)}
      />
      {/* Mounted either way and faded, so the darkening arrives with the sheet
          instead of snapping on in front of it. Over the work area only, like
          the sheet it belongs to and like the chat's two (bw-e3dw.9). */}
      <Button
        type="button"
        variant="foreground"
        aria-hidden={!railOpen}
        tabIndex={railOpen ? 0 : -1}
        aria-label="Close the file tree"
        data-testid="files-rail-scrim"
        data-open={railOpen}
        className={cn(
          'absolute inset-0 z-40 h-auto rounded-none bg-black/80 p-0 md:hidden',
          'transition-opacity duration-200 ease-out motion-reduce:transition-none',
          railOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={() => setRailOpen(false)}
      />
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid="files-viewer"
        data-file={file ?? undefined}
        data-line={line ?? undefined}
      >
        <OpenFilesStrip
          state={open}
          onPreview={preview}
          onPin={pin}
          onClose={close}
          onCloseCurrent={closeCurrent}
          dirty={dirty}
        />
        {!file || !kind ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">Pick a file</p>
          </div>
        ) : kind === 'text' ? (
          // Text, binaries with no preview of their own, and files that would
          // not read all go through the viewer, which already says so for each.
          <FileViewer
            root={root ?? ''}
            path={file}
            line={line}
            file={read.file}
            loading={read.file === null && read.error === null}
            error={read.error}
            onSaved={() => void readAgain()}
            onEditing={pin}
          />
        ) : (
          <FilePreview
            path={file}
            kind={kind}
            text={read.file?.kind === 'text' ? read.file.text : ''}
          />
        )}
      </div>
    </div>
  );
}
