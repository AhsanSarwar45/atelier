'use client';

/**
 * A pane a file can be dropped anywhere on.
 *
 * The writing box already took a drop, because CodeMirror answers `drop` on its
 * own content and puts the badge where the cursor landed. That is a target the
 * width of one line at the bottom of the screen: the owner dropped a file onto
 * the conversation, where there is room to aim, and the browser did what a
 * browser does with a file nobody caught — it left the app and opened the file
 * (bw-p4r3.1). So the whole pane catches it, and the line keeps its own aim.
 *
 * Two rules make the two targets one behaviour rather than two:
 *
 *  - A drop the box already answered is left alone. CodeMirror prevents the
 *    default on the drop it takes, and the event goes on bubbling to here, so
 *    `defaultPrevented` is the whole of the question — no geometry, no ref
 *    comparison, and nothing here that knows what is inside it.
 *  - A drag carrying no files is not ours. Text dragged inside the box, and a
 *    link dragged in from another tab, both raise these same events; `Files` in
 *    `dataTransfer.types` is the browser's own answer to which is which, and it
 *    is the only thing readable during a drag — the files themselves are not
 *    handed over until the drop.
 *
 * The veil takes no pointer events. An overlay that did would become the drop
 * target the moment it appeared, and the `dragleave` that costs would put it
 * away again a frame later, over and over, for as long as the file hovered.
 */

import { useRef, useState, type DragEvent, type ReactNode } from 'react';

import { Upload } from 'lucide-react';

import { Panel } from '@/components/ui/panel';
import { cn } from '@/lib/utils';

/** Is this drag carrying files, rather than text or a link? */
export function carriesFiles(transfer: DataTransfer | null | undefined): boolean {
  return Array.from(transfer?.types ?? []).includes('Files');
}

export function FileDropTarget({
  onFiles,
  saying = 'Drop to attach',
  disabled = false,
  className,
  children,
}: {
  onFiles: (files: File[]) => void;
  /** What the veil says while a file is over the pane. */
  saying?: string;
  /** A pane that cannot take one — a chat another program is holding. */
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  // `dragenter` and `dragleave` both fire again for every element the pointer
  // crosses inside the pane, so the veil is counted up and down rather than
  // switched: a leave for the row being left arrives AFTER the enter for the
  // row being entered, and a boolean would flicker the whole way across.
  const depth = useRef(0);

  function forget() {
    depth.current = 0;
    setOver(false);
  }

  if (disabled) return <div className={className}>{children}</div>;

  return (
    <div
      className={cn('relative', className)}
      data-testid="file-drop"
      data-over={over ? 'yes' : undefined}
      onDragEnter={(event: DragEvent) => {
        if (!carriesFiles(event.dataTransfer)) return;
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(event: DragEvent) => {
        if (!carriesFiles(event.dataTransfer)) return;
        // Without this the browser refuses the drop and opens the file itself.
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event: DragEvent) => {
        if (!carriesFiles(event.dataTransfer)) return;
        depth.current -= 1;
        if (depth.current <= 0) forget();
      }}
      onDrop={(event: DragEvent) => {
        forget();
        if (event.defaultPrevented || !carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length) onFiles(files);
      }}
    >
      {children}
      {over && (
        <div
          data-testid="file-drop-veil"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-6"
        >
          <Panel
            tone="info"
            inset="md"
            className="flex items-center gap-2 border-dashed text-sm text-info shadow-lg"
          >
            <Upload className="size-4" aria-hidden="true" />
            {saying}
          </Panel>
        </div>
      )}
    </div>
  );
}
