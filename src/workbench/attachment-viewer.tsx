'use client';

/**
 * An attachment, opened full size — in the Files tab's own readers.
 *
 * A picture already had this: click the thumbnail and it fills the screen, with
 * the wheel zoom and the drag (`picture-viewer.tsx`). Everything else had
 * nothing, so this grew a `<video>`, an `<audio>`, an `<iframe>` and a `<pre>`
 * of its own — a second, worse answer to a question the Files tab had already
 * answered properly. The owner asked why: "we already have the whole Files
 * functionality where we can show syntax highlighted text files. why didn't you
 * use that?" (bw-p4r3.2).
 *
 * So there is one set of readers now. `previewKind` decides what a file is, the
 * same function the Files tab decides by, and `FilePreview` draws it — the
 * checkerboard behind a picture, the scrubbable video, the PDF frame, Markdown
 * either read or as source. Text goes to `CodeEditor`, read-only, which is the
 * viewer the Files tab puts a file in: the grammar is chosen from the name, so
 * an attached `.ts` opens highlighted rather than as a wall of monospace.
 *
 * What this file still owns is the dialog — the screen-sized frame, the way
 * out, and the bytes. The bytes are the one thing the Files tab cannot work
 * out for itself: an attachment lives in the content-addressed store under a
 * digest, not at a path in the checkout, which is what `src` overrides.
 */
import { useEffect, useState } from 'react';

import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { request } from '@/lib/api';
import { lookOf } from '@/workbench/attachment-look';
import { attachmentSrc } from '@/workbench/attachment-store';
import { CodeEditor } from '@/workbench/code-editor';
import { FilePreview, PREVIEWS_NEEDING_TEXT, previewKind } from '@/workbench/file-preview';
import { PictureViewer } from '@/workbench/picture-viewer';
import type { ImagePayload, LookableImage } from '@/workbench/protocol';

/**
 * The file's own words, read from the store when the reader opens it.
 *
 * Only the head of it. A log is the one attachment that is routinely enormous,
 * and a reader opening one wants to see what it is, not to hand the browser
 * forty megabytes of text to lay out.
 */
const MOST_WORDS = 200_000;

function useWords(src: string, wanted: boolean) {
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    setSaid(null);
    setFailed(null);
    request(src)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`${res.status}`))))
      .then((text) => { if (live) setSaid(text.slice(0, MOST_WORDS)); })
      .catch((e: unknown) => { if (live) setFailed(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [src, wanted]);

  return { said, failed };
}

export function AttachmentViewer({ image, onClose }: { image: LookableImage; onClose: () => void }) {
  const single: ImagePayload | null = 'mode' in image ? null : image;
  const look = single ? lookOf(single) : 'picture';
  const name = single?.path ?? single?.alt ?? '';
  // What the Files tab would call this file. The name is enough: it is what
  // chooses the view there too.
  const kind = previewKind(name);
  const src = single ? attachmentSrc(single) : '';
  const { said, failed } = useWords(src, Boolean(single) && look !== 'picture' && PREVIEWS_NEEDING_TEXT.includes(kind));

  // A comparison, and a picture, are the picture viewer's own: it has the zoom,
  // the pan and the wipe, and none of that is this dialog's business.
  if (!single || look === 'picture') return <PictureViewer image={image} onClose={onClose} />;

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

        {kind === 'text' ? (
          <div data-testid="attachment-words" className="flex h-full w-full min-h-0 flex-col overflow-hidden rounded">
            {failed ? (
              <p className="text-sm text-white">{single.alt} could not be read. {failed}</p>
            ) : said === null ? (
              <p className="text-sm text-white">Reading {single.alt}…</p>
            ) : (
              // The Files tab's reader, read-only: the grammar comes off the
              // name, so an attached source file opens highlighted.
              <CodeEditor text={said} path={name} editable={false} className="min-h-0 flex-1" />
            )}
          </div>
        ) : (
          <FilePreview
            path={name}
            kind={kind}
            text={said ?? ''}
            src={src}
            // Opened on purpose, so it starts playing — which is what the
            // thumbnail's play button promised — and it grows to the screen it
            // was opened onto rather than sitting in the middle of it at 320px.
            autoPlay
            fills
            className="h-full w-full overflow-hidden rounded"
          />
        )}

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
