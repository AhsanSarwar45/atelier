/**
 * One attached file, drawn the same way wherever it is shown.
 *
 * The writing box and a sent message show the reader the same thing — the files
 * that travel with this message — so they draw it with the same component. Two
 * drawings of one idea is two chances for them to disagree about what a zip
 * looks like.
 *
 * A picture is its own preview. Everything else is its kind's icon and its
 * name, in the colour that kind wears everywhere else in the app
 * (`components/file-kinds.ts`), so an archive here and an archive in a path an
 * agent wrote are recognisably the same sort of thing.
 */
import { X } from 'lucide-react';

import { FILE_KINDS, fileKind } from '@/components/file-kinds';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { attachmentSrc } from '@/workbench/attachment-store';
import type { ImagePayload } from '@/workbench/protocol';

export interface AttachmentTileProps {
  file: ImagePayload & { id?: string };
  /** What a press does, when there is something to open. */
  onOpen?: () => void;
  /** Taking this file out of the message, when the reader may. */
  onRemove?: () => void;
}

/** How tall every tile is, whatever it holds, so a row of them lines up. */
const TILE = 'h-12 rounded border border-border/60';

export function AttachmentTile({ file, onOpen, onRemove }: AttachmentTileProps) {
  const kind = fileKind(file.alt);
  const Icon = FILE_KINDS[kind].icon;
  const opens = Boolean(onOpen);

  const body =
    kind === 'image' ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        data-testid="attachment-thumb"
        data-file-kind={kind}
        id={file.id ? `composer-image-${file.id}` : undefined}
        src={attachmentSrc(file)}
        alt={file.alt}
        onClick={onOpen}
        className={cn(TILE, 'w-12 object-cover', opens && 'cursor-zoom-in')}
      />
    ) : (
      <Button
        type="button"
        variant="foreground"
        size="none"
        data-testid="attachment-thumb"
        data-file-kind={kind}
        onClick={onOpen}
        disabled={!opens}
        className={cn(
          TILE,
          'flex max-w-[14rem] items-center justify-start gap-2 px-2 text-left font-normal',
          FILE_KINDS[kind].color,
          opens ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span className="truncate font-mono text-xs">{file.alt}</span>
      </Button>
    );

  return (
    <span className="relative">
      <Tooltip label={opens ? `${file.alt} — click to see it full size` : file.alt}>{body}</Tooltip>
      {onRemove && (
        <Button
          variant="outline"
          mode="icon"
          size="xs"
          radius="full"
          data-testid="attachment-remove"
          /* Its own twenty pixels on a phone as well as a desktop. The
             coarse-pointer floor would take it to 44 square, which is bigger
             than the corner of the 48px tile it is pinned to: it covered the
             picture, so the one press a reader has removed the attachment
             instead of opening it, and the cross drew "far too big"
             (bw-e9p5.2). What the thumb is aiming at here is the tile, which is
             already well over the floor; the reasoning is written where the
             mark is read, in globals.css. */
          data-reach="own"
          aria-label={`Remove ${file.alt}`}
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 h-5 w-5 shadow"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </span>
  );
}
