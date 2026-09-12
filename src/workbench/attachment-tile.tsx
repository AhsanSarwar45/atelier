/**
 * One attached file, drawn the same way wherever it is shown.
 *
 * The writing box and a sent message show the reader the same thing — the files
 * that travel with this message — so they draw it with the same component. Two
 * drawings of one idea is two chances for them to disagree about what a zip
 * looks like.
 *
 * Every tile is the SAME SQUARE, whatever it holds. A picture is drawn in it, a
 * video's own first frame is drawn in it, and everything else gets its kind's
 * icon over its name. They were laid out per kind first — the picture square,
 * the rest a wide pill of icon-then-name — and a row mixing the two did not
 * line up at all: the owner asked for one shape and he is right, a strip of
 * attachments reads as a set or it reads as a mess (bw-oamr.7).
 *
 * The icon and the colour are the kind's own, the ones it wears everywhere else
 * in the app (`components/file-kinds.ts`), so an archive here and an archive in
 * a path an agent wrote are recognisably the same sort of thing.
 */
import { Play, X } from 'lucide-react';

import { FILE_KINDS, fileKind } from '@/components/file-kinds';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { attachmentSrc } from '@/workbench/attachment-store';
import { lookOf, opens } from '@/workbench/attachment-look';
import type { ImagePayload } from '@/workbench/protocol';

export interface AttachmentTileProps {
  file: ImagePayload & { id?: string };
  /** What a press does. Left off when there is nothing to open. */
  onOpen?: () => void;
  /** Taking this file out of the message, when the reader may. */
  onRemove?: () => void;
}

/**
 * The square. Eighty pixels holds a legible icon over a name of a few
 * characters; the forty-eight a picture thumbnail used to get held neither.
 */
const SQUARE = 'size-20 shrink-0 overflow-hidden rounded border border-border/60';

/** The mark that says a thing plays, over the corner of what it plays. */
function PlayBadge() {
  return (
    <span
      aria-hidden="true"
      data-testid="attachment-play"
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <span className="flex size-7 items-center justify-center rounded-full bg-black/60 text-white shadow">
        <Play className="size-4 translate-x-px fill-current" />
      </span>
    </span>
  );
}

/**
 * What fills the box, whatever shape the box is.
 *
 * The writing box's tray is a row of eighty-pixel squares and a sent message is
 * a bounded grid of wider cells, because a screenshot in a conversation has to
 * be recognisable and a tray is a tray. Those are two boxes; what goes IN one
 * is the same question in both, and asking it twice is how the two drawings of
 * a zip come to disagree (bw-oamr.9).
 *
 * A picture and a video fill the box with themselves; everything else stacks
 * its kind's icon over its name, which is the only thing there is to say about
 * a zip.
 *
 * A video is asked only for its metadata, and for the frame a tenth of a second
 * in: a video that opens on black — and many do — would otherwise draw as an
 * empty box, which says less than the icon would have.
 */
export function AttachmentFace({ file, fit = 'cover' }: { file: ImagePayload; fit?: 'cover' | 'contain' }) {
  const kind = fileKind(file.alt);
  const look = lookOf(file);
  const Icon = FILE_KINDS[kind].icon;
  const src = attachmentSrc(file);
  const how = fit === 'contain' ? 'object-contain' : 'object-cover';

  if (look === 'picture') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={file.alt} className={cn('size-full', how)} />;
  }
  if (look === 'video') {
    return (
      <>
        <video
          data-testid="attachment-frame"
          src={`${src}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          className={cn('size-full bg-black', how)}
        />
        <PlayBadge />
      </>
    );
  }
  return (
    <span className={cn('flex size-full flex-col items-center justify-center gap-1 px-1', FILE_KINDS[kind].color)}>
      {/* A recording has no frame to show, so what stands in its place is the
          thing you would press: a play button over its name, which is what the
          owner asked for and is also the only useful thing to say about an
          audio file at eighty pixels. */}
      {look === 'audio' ? (
        <span data-testid="attachment-play" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-current/15">
          <Play className="size-4 translate-x-px fill-current" aria-hidden="true" />
        </span>
      ) : (
        <Icon className="size-8 shrink-0" aria-hidden="true" />
      )}
      {/* Two lines, and broken anywhere: `contract.pdf` does not fit across
          eighty pixels on one line and a name cut to `contract.p…` has lost the
          one part of it that says what the file is. */}
      <span className="line-clamp-2 w-full break-all text-center font-mono text-[0.625rem] leading-tight">{file.alt}</span>
    </span>
  );
}

export function AttachmentTile({ file, onOpen, onRemove }: AttachmentTileProps) {
  const kind = fileKind(file.alt);
  const look = lookOf(file);
  const openable = Boolean(onOpen) && opens(file);
  const press = openable ? onOpen : undefined;

  return (
    <span className="relative">
      <Tooltip label={openable ? `${file.alt} — click to open it full size` : file.alt}>
        <Button
          type="button"
          variant="foreground"
          size="none"
          data-testid="attachment-thumb"
          data-file-kind={kind}
          data-look={look}
          aria-label={file.alt}
          onClick={press}
          disabled={!openable}
          className={cn(SQUARE, 'relative block p-0', openable ? 'cursor-zoom-in' : 'cursor-default')}
        >
          <AttachmentFace file={file} />
        </Button>
      </Tooltip>
      {onRemove && (
        <Button
          variant="outline"
          mode="icon"
          size="xs"
          radius="full"
          data-testid="attachment-remove"
          /* Its own twenty pixels on a phone as well as a desktop. The
             coarse-pointer floor would take it to 44 square, which is bigger
             than the corner of the tile it is pinned to: it covered the
             picture, so the one press a reader has removed the attachment
             instead of opening it, and the cross drew "far too big"
             (bw-e9p5.2). What the thumb is aiming at here is the tile, which is
             already well over the floor; the reasoning is written where the
             mark is read, in globals.css. */
          data-reach="own"
          aria-label={`Remove ${file.alt}`}
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 z-10 h-5 w-5 shadow"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </span>
  );
}
