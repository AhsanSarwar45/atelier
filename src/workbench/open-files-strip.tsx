'use client';

/**
 * The strip of open files above the viewer (bw-g3o3.14).
 *
 * It draws what `open-files.ts` decides: a tab per open file, the one being
 * read lit, and the preview slot in italics so a reader can see at a glance
 * that their next click will take it away. The ways out are the ones every
 * editor has — the ×, a middle click, and Ctrl+W for the one in front.
 *
 * The dirty dot is the seam for editing (bw-g3o3.8): hand `dirty` the paths
 * with unsaved changes and the tab wears a dot in place of its ×, and call
 * `onPin` on the first keystroke so an edited file cannot be replaced out of
 * the preview slot mid-sentence. Nothing here reads or writes a file itself.
 */

import { useEffect, type MouseEvent } from 'react';

import { X } from 'lucide-react';

import { FILE_KINDS, fileKind } from '@/components/file-kinds';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { OpenFiles } from '@/workbench/open-files';

/**
 * The kind's own ink, pulled out of the badge classes so a tab, a badge and a
 * tree row all colour the same extension the same way. The badge string is
 * border + background + text together; only the text half belongs on an icon.
 */
function inkFor(path: string): string {
  const classes = FILE_KINDS[fileKind(path)].color.split(' ');
  return classes.find((one) => one.startsWith('text-')) ?? 'text-t-muted';
}

/** What a tab is called: the file's own name, not the path that led to it. */
export function tabName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export interface OpenFilesStripProps {
  state: OpenFiles;
  /** A single click: show it, taking the preview slot if it is new. */
  onPreview: (path: string) => void;
  /** A double click: keep it. */
  onPin: (path: string) => void;
  /** The ×, or a middle click. */
  onClose: (path: string) => void;
  /** Ctrl+W. */
  onCloseCurrent: () => void;
  /** Open files with unsaved edits, filled by bw-g3o3.8. */
  dirty?: ReadonlySet<string>;
  className?: string;
}

export function OpenFilesStrip({
  state,
  onPreview,
  onPin,
  onClose,
  onCloseCurrent,
  dirty,
  className,
}: OpenFilesStripProps) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'w' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      // A browser keeps Ctrl+W for its own tab and will not always give it up,
      // so this is asked for rather than assumed. Where the app owns the key —
      // a desktop window — it closes the file, which is what a reader means.
      event.preventDefault();
      onCloseCurrent();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onCloseCurrent]);

  if (state.files.length === 0) return null;

  return (
    <div
      data-testid="open-files-strip"
      role="tablist"
      aria-label="Open files"
      className={cn(
        'flex shrink-0 items-stretch overflow-x-auto border-b border-b-default bg-surface-inset/40',
        className,
      )}
    >
      {state.files.map((file) => {
        const current = file.path === state.current;
        const unsaved = dirty?.has(file.path) === true;
        const Icon = FILE_KINDS[fileKind(file.path)].icon;
        const shut = (event: MouseEvent) => {
          event.stopPropagation();
          onClose(file.path);
        };
        return (
          // The whole path on hover: a strip full of `index.ts` is otherwise
          // several files with one name.
          <Tooltip key={file.path} label={file.path} side="bottom">
            <div
              data-testid="open-file"
              data-path={file.path}
              data-preview={file.preview || undefined}
              data-current={current || undefined}
              data-dirty={unsaved || undefined}
              role="tab"
              tabIndex={0}
              aria-selected={current}
              className={cn(
                'group flex max-w-[16rem] shrink-0 cursor-pointer items-center gap-1.5 border-r border-r-default px-2.5 py-1.5 text-xs',
                current
                  ? 'bg-surface-base text-t-primary'
                  : 'text-t-muted hover:bg-surface-raised/60 hover:text-t-secondary',
              )}
              onClick={() => onPreview(file.path)}
              onDoubleClick={() => onPin(file.path)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onPreview(file.path);
                }
              }}
              // A middle click on a scrollable strip otherwise starts the
              // browser's own auto-scroll and leaves the tab open underneath it.
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
              onAuxClick={(event) => { if (event.button === 1) shut(event); }}
            >
              <Icon className={cn('h-3.5 w-3.5 shrink-0', inkFor(file.path))} />
              <span className={cn('truncate', file.preview && 'italic')}>{tabName(file.path)}</span>
              {unsaved ? (
                <span
                  data-testid="open-file-dirty"
                  aria-label="Unsaved changes"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-t-secondary"
                />
              ) : (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  data-testid="open-file-close"
                  aria-label={`Close ${tabName(file.path)}`}
                  className={cn(
                    'size-4 shrink-0 text-t-faint hover:text-t-primary',
                    // Out of the way until the tab is being used, so a strip at
                    // rest reads as names rather than as a row of crosses.
                    current ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                  )}
                  onClick={shut}
                >
                  <X className="size-3" />
                </Button>
              )}
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}
