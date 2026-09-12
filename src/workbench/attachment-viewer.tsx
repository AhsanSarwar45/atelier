'use client';

/**
 * An attachment, opened full size.
 *
 * A picture already had this — click the thumbnail and it fills the screen,
 * with the wheel zoom and the drag (`picture-viewer.tsx`). Everything else had
 * nothing: a video was a file name and an audio file was a file name, and the
 * owner asked for the same gesture to work on all of them. So this stands in
 * front of the picture viewer and hands a picture straight through to it, and
 * answers for the rest itself.
 *
 * The bytes come from the store over the app's own media route, which is what
 * makes a `<video>` here possible at all: a source the browser can range-request
 * and seek in, rather than a base64 data URL it would have to hold whole.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { request } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { attachmentSrc } from '@/workbench/attachment-store';
import { lookOf } from '@/workbench/attachment-look';
import { PictureViewer } from '@/workbench/picture-viewer';
import type { ImagePayload, LookableImage } from '@/workbench/protocol';

/** A file's own words, read from the store when the reader opens it. */
function Words({ src, name }: { src: string; name: string }) {
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Only the head of it. A log is the one attachment that is routinely
    // enormous, and a reader opening one wants to see what it is, not to hand
    // the browser forty megabytes of text to lay out.
    request(src)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`${res.status}`))))
      .then((text) => { if (live) setSaid(text.slice(0, 200_000)); })
      .catch((e: unknown) => { if (live) setFailed(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [src]);

  if (failed) return <p className="text-sm text-white">{name} could not be read. {failed}</p>;
  if (said === null) return <p className="text-sm text-white">Reading {name}…</p>;
  return (
    <pre data-testid="attachment-words" className="h-full w-full overflow-auto rounded bg-black/40 p-4 text-left font-mono text-xs leading-relaxed text-white">
      {said}
    </pre>
  );
}

export function AttachmentViewer({ image, onClose }: { image: LookableImage; onClose: () => void }) {
  const single: ImagePayload | null = 'mode' in image ? null : image;
  const look = single ? lookOf(single) : 'picture';
  // A comparison, and a picture, are the picture viewer's own: it has the zoom,
  // the pan and the wipe, and none of that is this dialog's business.
  if (!single || look === 'picture') return <PictureViewer image={image} onClose={onClose} />;

  const src = attachmentSrc(single);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        shape="screen"
        hideClose
        overlayClassName="bg-black/80"
        aria-describedby={undefined}
        aria-label={single.alt}
        data-testid="attachment-viewer"
        data-look={look}
        className="flex h-full w-full flex-col items-center justify-center gap-4 p-2 pt-16 sm:p-6 sm:pt-16"
      >
        <DialogTitle className="sr-only">{single.alt}</DialogTitle>

        {look === 'video' && (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            data-testid="attachment-video"
            src={src}
            controls
            autoPlay
            /* Grown to the room, not drawn at its own pixel size: a 320x240
               clip in the middle of a 1280px screen is a postage stamp, and
               the picture beside it in the same strip opens filling the
               screen. `object-contain` keeps its shape while it grows. */
            className="h-full w-full rounded object-contain"
          />
        )}
        {look === 'audio' && (
          <div className="flex w-full max-w-xl flex-col items-center gap-3">
            <p className="font-mono text-sm text-white">{single.alt}</p>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio data-testid="attachment-audio" src={src} controls autoPlay className="w-full" />
          </div>
        )}
        {look === 'pdf' && (
          <iframe data-testid="attachment-pdf" src={src} title={single.alt} className="h-full w-full rounded bg-white" />
        )}
        {look === 'words' && <Words src={src} name={single.alt} />}

        <Button
          variant="ghost"
          mode="icon"
          size="sm"
          aria-label="Close"
          data-testid="attachment-viewer-close"
          className="absolute right-4 top-4 z-20 text-white"
          onClick={onClose}
        >
          <X className="h-5 w-5" />
        </Button>
      </DialogContent>
    </Dialog>
  );
}
