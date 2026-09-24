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

import { useEffect } from 'react';

import { FILE_KINDS, fileKind } from '@/components/file-kinds';
import { BadgeDot } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
    // Chosen with the mouse or with Enter and Space, as before; the arrow keys
    // only walk along the strip, so passing a file on the way to another does
    // not open it.
    <Tabs value={state.current ?? ''} onValueChange={onPreview} activationMode="manual">
      <TabsList
        variant="strip"
        data-testid="open-files-strip"
        aria-label="Open files"
        className={className}
      >
        {state.files.map((file) => {
          const current = file.path === state.current;
          const unsaved = dirty?.has(file.path) === true;
          const Icon = FILE_KINDS[fileKind(file.path)].icon;
          return (
            // The whole path on hover: a strip full of `index.ts` is otherwise
            // several files with one name.
            <Tooltip key={file.path} label={file.path} side="bottom">
              <TabsTrigger
                value={file.path}
                data-testid="open-file"
                data-path={file.path}
                data-preview={file.preview || undefined}
                data-current={current || undefined}
                data-dirty={unsaved || undefined}
                onDoubleClick={() => onPin(file.path)}
                onClose={() => onClose(file.path)}
                closeLabel={`Close ${tabName(file.path)}`}
                closeTestId="open-file-close"
                closeMark={
                  unsaved ? (
                    <BadgeDot
                      solid
                      data-testid="open-file-dirty"
                      aria-label="Unsaved changes"
                      className="mr-1.5 text-t-secondary"
                    />
                  ) : undefined
                }
              >
                <Icon className={inkFor(file.path)} />
                <span className={cn('truncate', file.preview && 'italic')}>{tabName(file.path)}</span>
              </TabsTrigger>
            </Tooltip>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
