'use client';

/**
 * A file on screen: where it is, how big it is, two ways out to the machine,
 * and the text itself in CodeMirror.
 *
 * It is handed its file rather than fetching one, so the read route, the tab
 * around it and this can be built and tested apart from each other.
 *
 * Copying out of it copies a REFERENCE — `@src/a.ts:12-40` — and not the lines,
 * the same bargain the git diff strikes (bw-gr8y.8): what a reader usually
 * wants after reading a few lines is to say "these lines" to the agent, and
 * that is one gesture rather than a retyped path. The code itself is never
 * further than the "Copy text" button in the header or the one the selection
 * raises beside it (bw-g3o3.10).
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { Copy, ExternalLink, FolderOpen, Pencil } from 'lucide-react';

import { isMarkdownPath } from '@/components/file-kinds';
import { BadgeDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { PopoverAtPoint, type PointerAt } from '@/components/ui/point-anchor';
import { Popover, PopoverContent } from '@/components/ui/popover';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { CodeEditor, type CopiedSelection } from '@/workbench/code-editor';
import { MarkdownPane, SourceSwitch } from '@/workbench/file-preview';
import { openLocalPath } from '@/workbench/open-local-path';
import { referenceUnder, relativeToRoot } from '@/workbench/references';
import { useFileEdits } from '@/workbench/use-file-edits';

/**
 * What the read route answers with, named structurally so this file does not
 * have to wait on the route that defines it (bw-g3o3.2).
 */
export type ViewedFile =
  | {
      kind: 'text';
      text: string;
      /** The file was longer than the route is willing to send. */
      truncated?: boolean;
      size: number;
      sha256?: string;
      mtime?: string | number;
    }
  | { kind: 'binary'; size: number };

/** Past here the file is shown as plain text: no grammar, no folding, no gutter. */
export const PLAIN_ABOVE_BYTES = 2 * 1024 * 1024;
export const PLAIN_ABOVE_LINES = 50_000;

/** Bytes as a person says them. Powers of 1024, one decimal past a kilobyte. */
export function humaneSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? Math.round(size) : Math.round(size * 10) / 10} ${units[unit]}`;
}

/**
 * Whether the text is more than the parser and the folding should be asked to
 * carry. CodeMirror itself draws only the viewport and does not mind the
 * length; the grammar walks all of it, which is what the guard is for.
 */
export function tooLargeToParse(size: number, text: string): boolean {
  if (size > PLAIN_ABOVE_BYTES) return true;
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    lines += 1;
    if (lines > PLAIN_ABOVE_LINES) return true;
  }
  return false;
}

function Breadcrumb({ relative }: { relative: string }) {
  const parts = relative.split('/').filter(Boolean);
  const name = parts.length > 0 ? parts[parts.length - 1] : relative;
  const folders = parts.slice(0, -1);
  return (
    <span data-testid="file-viewer-breadcrumb" className="flex min-w-0 items-baseline gap-1 truncate font-mono text-xs">
      {folders.map((folder, at) => (
        <span key={`${folder}-${at}`} className="shrink-0 text-t-faint">
          {folder}
          <span className="px-1 text-t-faint/60">/</span>
        </span>
      ))}
      <span className="truncate font-medium text-t-primary">{name}</span>
    </span>
  );
}

/**
 * The one mark that says a file has work in it that is not on disk. The same
 * shape the open-files strip draws on its tabs, so the two read as one thing.
 */
function UnsavedDot() {
  return (
    <Tooltip label="Unsaved changes">
      <BadgeDot
        solid
        data-testid="file-viewer-dirty"
        aria-label="Unsaved changes"
        className="text-warning"
      />
    </Tooltip>
  );
}

function PaneMessage({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-t-muted">
      {children}
    </div>
  );
}

export interface FileViewerProps {
  /** The project or worktree the path is read against, for the breadcrumb. */
  root: string;
  /** The absolute path of the file on the machine. */
  path: string;
  /** One-based line to mark and scroll to, from the address. */
  line?: number | null;
  /** The file, or nothing while there is not one yet. */
  file: ViewedFile | null;
  loading?: boolean;
  error?: string | null;
  /**
   * Told after a save landed, with the path that was written. The tab uses it
   * to re-read the folder, so the tree's size and time catch up at once rather
   * than waiting on the watch (bw-g3o3.8).
   */
  onSaved?: (path: string) => void;
  /**
   * Told the first time this file is opened for typing — the Edit button, or a
   * keystroke into one still read-only. The tab pins the preview slot on it, so
   * a file being edited cannot be replaced out from under the sentence being
   * typed by the next click in the tree (bw-g3o3.18).
   */
  onEditing?: (path: string) => void;
  className?: string;
}

export function FileViewer({
  root,
  path,
  line = null,
  file,
  loading = false,
  error = null,
  onSaved,
  onEditing,
  className,
}: FileViewerProps) {
  const relative = relativeToRoot(root, path);
  const size = file ? file.size : null;
  const plain = file && file.kind === 'text' && tooLargeToParse(file.size, file.text);

  // Only a whole text file is editable. A binary one has nothing to type into,
  // and a truncated one was never shown in full — saving back what is on screen
  // would cut the rest of the file off, which is why the server refuses it too.
  const editableFile = file?.kind === 'text' && !file.truncated && !plain;
  const read = useMemo(
    () => (editableFile && file?.kind === 'text' ? { text: file.text, sha: file.sha256 ?? null } : null),
    [editableFile, file],
  );
  const edits = useFileEdits(editableFile ? path : null, read);

  /**
   * Markdown is read one way and written another, and the reader says which.
   *
   * It opens rendered, because that is what a `.md` file is usually opened FOR
   * and it is what this file used to do before it could be edited at all. The
   * source is a switch away, and the pencil is a shortcut to that switch —
   * pressing Edit while looking at the rendered words means "let me type", and
   * there is nothing to type into on that side (bw-tzg0.1).
   */
  const markdown = isMarkdownPath(path);
  const [showing, setShowing] = useState<'source' | 'preview'>('preview');
  // A different file is read before it is written, whatever the last one was.
  useEffect(() => setShowing('preview'), [path]);
  // Only a whole, coloured markdown file has two sides. Too large to parse is
  // drawn plain by the branch below, and a binary has neither side.
  const twoWays = markdown && file?.kind === 'text' && !plain;
  const rendered = twoWays && showing === 'preview';
  /** What the rendered side draws: the words being typed, not the saved ones. */
  const live = file?.kind === 'text' ? (editableFile ? edits.text : file.text) : '';

  /** What is selected in the editor now, and where the offer beside it sits. */
  const [selection, setSelection] = useState<{ copied: CopiedSelection; at: PointerAt } | null>(null);

  // Where the button goes is the browser's business — the selection CodeMirror
  // reports is in document positions, and only the page knows where those are
  // drawn. A selection has no box where there is no layout, which is every
  // test; the offer still stands, it just has nowhere in particular to sit.
  const selected = useCallback((copied: CopiedSelection | null) => {
    if (!copied) return setSelection(null);
    const range = typeof window === 'undefined' ? null : window.getSelection();
    const box = (range?.rangeCount ? range.getRangeAt(0).getBoundingClientRect?.() : null) ?? {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    };
    setSelection({ copied, at: { left: box.left, top: box.top, width: box.width, height: box.height } });
  }, []);

  // A different file is a different selection; the one from the last file must
  // not outlive it and offer up lines this file has never had. Turning a
  // markdown file round to its rendered side takes the selection with it — the
  // lines it named are not on screen any more.
  useEffect(() => setSelection(null), [path, showing]);

  /**
   * The reference a copy is answered with. The whole point of the card: what
   * lands on the clipboard is what the composer draws as a badge, written
   * through the one grammar, so it cannot drift from the diff's answer.
   */
  const reference = useCallback(
    (copied: CopiedSelection) =>
      referenceUnder({ root, path, line: copied.fromLine, endLine: copied.toLine }),
    [root, path],
  );

  /** The escape hatch: the code itself, the selection's or the whole file's. */
  const copyText = useCallback(() => {
    const wanted = selection?.copied.text ?? (file?.kind === 'text' ? file.text : '');
    if (wanted) void navigator.clipboard?.writeText(wanted);
  }, [selection, file]);
  // Opening the file up, and the strip told about it: pinning is the tab's to
  // do, and it only ever has this to go on.
  const opening = edits.open;
  const startEditing = useCallback(() => {
    opening();
    setShowing('source');
    onEditing?.(path);
  }, [opening, onEditing, path]);

  // A save, and then the folder read again — whether it landed or was refused,
  // since a refusal means the file moved and the tree is out of date either way.
  const asked = edits.save;
  const save = useCallback(async () => {
    await asked();
    onSaved?.(path);
  }, [asked, onSaved, path]);

  // Ctrl-S from anywhere in the pane, not only from inside the editor: the
  // reader may have just come back from the Reload/Keep banner or the Save
  // button, and neither of those gives the focus back.
  useEffect(() => {
    if (!editableFile) return () => {};
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 's' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editableFile, save]);

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      <div
        data-testid="file-viewer-header"
        className="flex shrink-0 items-center gap-2 border-b border-b-default bg-surface-raised/50 px-3 py-1.5"
      >
        <Breadcrumb relative={relative} />
        {edits.dirty && <UnsavedDot />}
        {size != null && (
          <span data-testid="file-viewer-size" className="shrink-0 text-[11px] tabular-nums text-t-faint">
            {humaneSize(size)}
          </span>
        )}
        <span className="flex-1" />
        {edits.error && (
          <span data-testid="file-viewer-save-error" className="shrink-0 truncate text-[11px] text-danger">
            {edits.error}
          </span>
        )}
        {twoWays && <SourceSwitch showing={showing} onChange={setShowing} />}
        {editableFile &&
          (edits.editable ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-t-muted hover:text-t-primary"
              disabled={!edits.dirty || edits.saving}
              data-testid="file-viewer-save"
              onClick={() => void save()}
            >
              {edits.saving ? 'Saving…' : 'Save'}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-t-muted hover:text-t-primary"
              title="Edit this file"
              aria-label="Edit this file"
              data-testid="file-viewer-edit"
              onClick={startEditing}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          ))}
        {file?.kind === 'text' && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-t-muted hover:text-t-primary"
            title="Copy text"
            aria-label="Copy text"
            data-testid="file-viewer-copy-text"
            // Pressing it must not be what takes the selection away, or the
            // button would hand over the whole file instead of the lines the
            // reader had just picked out.
            onMouseDown={(event) => event.preventDefault()}
            onClick={copyText}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-t-muted hover:text-t-primary"
          title="Open in editor"
          aria-label="Open in editor"
          data-testid="file-viewer-open-editor"
          onClick={() => openLocalPath(path, 'vscode', line)}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-t-muted hover:text-t-primary"
          title="Reveal in file manager"
          aria-label="Reveal in file manager"
          data-testid="file-viewer-reveal"
          onClick={() => openLocalPath(path, 'finder')}
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </Button>
      </div>

      {error ? (
        <PaneMessage testId="file-viewer-error">{error}</PaneMessage>
      ) : loading || !file ? (
        // Quiet on purpose: a spinner on every click through a tree is a flicker
        // the reader has to look past, and most reads answer inside one frame.
        <PaneMessage testId="file-viewer-loading">{loading ? 'Reading…' : 'No file open'}</PaneMessage>
      ) : file.kind === 'binary' ? (
        <PaneMessage testId="file-viewer-binary">Binary file, {humaneSize(file.size)}</PaneMessage>
      ) : plain ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <Panel shape="strip" inset="xs" className="shrink-0 text-[11px] text-t-muted">
            Too large to colour — showing it plain.
          </Panel>
          <pre data-testid="file-viewer-plain" className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-t-secondary">
            {file.text}
          </pre>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {file.truncated && (
            <Panel shape="strip" tone="attention" inset="xs" data-testid="file-viewer-truncated" className="shrink-0 text-[11px] text-t-secondary">
              Showing the first 2 MiB
            </Panel>
          )}
          {edits.outside && (
            <Panel
              shape="strip"
              tone="attention"
              inset="xs"
              data-testid="file-viewer-outside"
              className="flex shrink-0 items-center gap-2 text-[11px] text-t-secondary"
            >
              <span className="flex-1 truncate">This file changed on disk while you were editing it.</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-[11px]"
                data-testid="file-viewer-reload"
                onClick={edits.reload}
              >
                Reload
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-[11px]"
                data-testid="file-viewer-keep"
                onClick={edits.keep}
              >
                Keep mine
              </Button>
            </Panel>
          )}
          <div data-testid="file-viewer" className="flex min-h-0 min-w-0 flex-1 flex-col" data-dirty={edits.dirty ? '' : undefined}>
            {rendered ? (
              // Marked as the preview it is, and by the same names the preview
              // uses elsewhere: what a reader — or a case — asks about "the
              // markdown preview of this file" is this pane, whichever frame
              // happens to be holding it.
              <div data-testid="file-preview" data-kind="markdown" className="flex min-h-0 min-w-0 flex-1 flex-col">
                <MarkdownPane path={path} text={live} />
              </div>
            ) : (
            <CodeEditor
              text={editableFile ? edits.text : file.text}
              path={path}
              line={line}
              editable={edits.editable}
              onChange={edits.change}
              onEditIntent={editableFile ? startEditing : undefined}
              onSave={editableFile ? () => void save() : undefined}
              onSelection={selected}
              onSelectionCopy={reference}
              className="h-full"
            />
            )}
          </div>
          {/* The offer hangs off the selection's own box, placed by the
              library's popover: under its end, and flipped when there is no
              room below. It is not dismissed by a press elsewhere — it stands
              exactly as long as the selection does. */}
          <Popover open={selection !== null}>
            <PopoverAtPoint at={selection?.at ?? null} />
            {selection && (
              <PopoverContent
                data-testid="file-copy-text"
                side="bottom"
                align="end"
                sideOffset={6}
                // The keyboard stays in the editor, where the selection is.
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => event.preventDefault()}
                // Pressing the button must not be what takes the selection away,
                // or there would be nothing left to copy by the time the click
                // lands.
                onMouseDown={(event) => event.preventDefault()}
                className="w-auto border-0 bg-transparent p-0 shadow-none"
              >
                <Button type="button" size="xs" variant="outline" className="shadow-md" onClick={copyText}>
                  <Copy /> Copy text
                </Button>
              </PopoverContent>
            )}
          </Popover>
        </div>
      )}
    </div>
  );
}
