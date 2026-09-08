'use client';

/**
 * A file on screen: where it is, how big it is, two ways out to the machine,
 * and the text itself in CodeMirror.
 *
 * It is handed its file rather than fetching one, so the read route, the tab
 * around it and this can be built and tested apart from each other.
 */

import type { ReactNode } from 'react';

import { ExternalLink, FolderOpen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CodeEditor } from '@/workbench/code-editor';
import { openLocalPath } from '@/workbench/open-local-path';

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
 * The path as it reads under the project: the folders that lead to it and the
 * name at the end. A file outside the root keeps its whole path rather than
 * being given a misleading short one.
 */
export function relativeToRoot(root: string, path: string): string {
  if (!root) return path;
  const base = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
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

function Notice({ testId, children }: { testId: string; children: ReactNode }) {
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
  className?: string;
}

export function FileViewer({ root, path, line = null, file, loading = false, error = null, className }: FileViewerProps) {
  const relative = relativeToRoot(root, path);
  const size = file ? file.size : null;
  const plain = file && file.kind === 'text' && tooLargeToParse(file.size, file.text);

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      <div
        data-testid="file-viewer-header"
        className="flex shrink-0 items-center gap-2 border-b border-b-default bg-surface-raised/50 px-3 py-1.5"
      >
        <Breadcrumb relative={relative} />
        {size != null && (
          <span data-testid="file-viewer-size" className="shrink-0 text-[11px] tabular-nums text-t-faint">
            {humaneSize(size)}
          </span>
        )}
        <span className="flex-1" />
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
        <Notice testId="file-viewer-error">{error}</Notice>
      ) : loading || !file ? (
        // Quiet on purpose: a spinner on every click through a tree is a flicker
        // the reader has to look past, and most reads answer inside one frame.
        <Notice testId="file-viewer-loading">{loading ? 'Reading…' : 'No file open'}</Notice>
      ) : file.kind === 'binary' ? (
        <Notice testId="file-viewer-binary">Binary file, {humaneSize(file.size)}</Notice>
      ) : plain ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-b-default bg-surface-inset/40 px-3 py-1 text-[11px] text-t-muted">
            Too large to colour — showing it plain.
          </div>
          <pre data-testid="file-viewer-plain" className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-t-secondary">
            {file.text}
          </pre>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {file.truncated && (
            <div data-testid="file-viewer-truncated" className="shrink-0 border-b border-b-default bg-warning/10 px-3 py-1 text-[11px] text-t-secondary">
              Showing the first 2 MiB
            </div>
          )}
          <div data-testid="file-viewer" className="min-h-0 flex-1">
            <CodeEditor text={file.text} path={path} line={line} className="h-full" />
          </div>
        </div>
      )}
    </div>
  );
}
