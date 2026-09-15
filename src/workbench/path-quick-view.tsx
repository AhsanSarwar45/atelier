'use client';

/**
 * A file outside the project, looked at without leaving where the reader is
 * (bw-lolf.2).
 *
 * A file inside a checkout opens in the Files tab (`open-path.tsx`). One outside
 * every checkout used to leave for the desktop on a plain click, which threw the
 * reader out of the app for a file they only wanted to glance at. It opens here
 * instead, in the Files tab's own readers — the code viewer for text,
 * `FilePreview` for everything else — and the ways onward are buttons on it:
 * the Files tab, the editor, the file manager.
 */
import { useEffect, useState } from 'react';

import { ExternalLink, Files, FolderOpen, X, type LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/tooltip';
import * as api from '@/lib/api';
import { CodeEditor } from '@/workbench/code-editor';
import { FilePreview, PREVIEWS_NEEDING_TEXT, previewKind } from '@/workbench/file-preview';
import type { PathHow, PathTarget } from '@/workbench/path-chip';

type Read =
  | { state: 'reading' }
  | { state: 'text'; text: string }
  | { state: 'binary' }
  | { state: 'failed'; why: string };

function useRead(path: string, wanted: boolean): Read {
  const [read, setRead] = useState<Read>({ state: 'reading' });
  useEffect(() => {
    if (!wanted) return;
    const stop = new AbortController();
    setRead({ state: 'reading' });
    api.fs
      .read(path, stop.signal)
      .then((answer) => setRead(answer.kind === 'text' ? { state: 'text', text: answer.text ?? '' } : { state: 'binary' }))
      .catch((why: unknown) => {
        if (!stop.signal.aborted) setRead({ state: 'failed', why: why instanceof Error ? why.message : String(why) });
      });
    return () => stop.abort();
  }, [path, wanted]);
  return read;
}

export function PathQuickView({
  target,
  onGo,
  onClose,
}: {
  target: PathTarget;
  /** Leave the quick view for somewhere the file can be opened properly. */
  onGo: (how: PathHow) => void;
  onClose: () => void;
}) {
  const path = target.absolute;
  const name = path.slice(path.lastIndexOf('/') + 1) || path;
  const kind = previewKind(path);
  const needsText = PREVIEWS_NEEDING_TEXT.includes(kind);
  const read = useRead(path, needsText);

  const action = (how: PathHow, label: string, Icon: LucideIcon, testId: string) => (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        mode="icon"
        size="sm"
        aria-label={label}
        data-testid={testId}
        onClick={() => {
          onClose();
          onGo(how);
        }}
      >
        <Icon className="h-4 w-4" />
      </Button>
    </Tooltip>
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        data-testid="path-quick-view"
        data-path={path}
        className="flex h-[80vh] w-[min(960px,95vw)] max-w-none flex-col gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center gap-1 border-b px-3 py-2">
          <DialogTitle className="min-w-0 flex-1 truncate font-mono text-sm font-medium" title={path}>
            {name}
            {target.line === null ? null : <span className="text-muted-foreground">:{target.line}</span>}
          </DialogTitle>
          {action('files', 'Open in Files', Files, 'path-quick-view-files')}
          {action('editor', 'Open in editor', ExternalLink, 'path-quick-view-editor')}
          {action('reveal', 'Reveal in file manager', FolderOpen, 'path-quick-view-reveal')}
          <Button variant="ghost" mode="icon" size="sm" aria-label="Close" data-testid="path-quick-view-close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {!needsText ? (
            <FilePreview path={path} kind={kind} className="h-full w-full" />
          ) : read.state === 'reading' ? (
            <p className="p-4 text-sm text-muted-foreground">Reading…</p>
          ) : read.state === 'failed' ? (
            <p className="p-4 text-sm text-muted-foreground" data-testid="path-quick-view-error">{read.why}</p>
          ) : read.state === 'binary' ? (
            <p className="p-4 text-sm text-muted-foreground">Binary file</p>
          ) : kind === 'text' ? (
            <CodeEditor text={read.text} path={path} line={target.line} editable={false} className="min-h-0 flex-1" />
          ) : (
            <FilePreview path={path} kind={kind} text={read.text} className="h-full w-full" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
