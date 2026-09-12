/**
 * The files of one message, laid out the way a chat app lays pictures out.
 *
 * Stacked one under another at full bubble width, two screenshots pushed the
 * words of the message off the screen and a message of five was a page of its
 * own — which is what the manager was looking at (bw-uu9x.10). Every messaging
 * app answers this the same way: the files of one message are a block, the
 * block is held to a width, and how many stand side by side follows how many
 * there are.
 *
 * It held pictures only, so a message carrying a video, a recording or a zip
 * showed the reader nothing above the words — the writing box had shown all
 * three as tiles a moment earlier, and sending the message made them vanish
 * (bw-oamr.9). Every file is here now, drawn by the same `AttachmentFace` the
 * writing box's tray draws, so a zip looks like a zip in both places.
 *
 * The block is a thumbnail and nothing more. Clicking anything in it opens that
 * file whole, which is what makes cropping a cell safe — and it is also where
 * the wheel zoom and the drag live (bw-gy6z). A cell here is too small to look
 * around inside and would have to fight the transcript for the wheel, so the
 * gesture belongs to the viewer that opens, not to the thumbnail.
 */
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { AttachmentFace } from '@/workbench/attachment-tile';
import { lookOf, opens } from '@/workbench/attachment-look';
import { inlineMediaBounds } from '@/workbench/media-bounds';
import type { ImagePayload } from '@/workbench/protocol';
import { attachmentSrc } from '@/workbench/attachment-store';
import { fileKind } from '@/components/file-kinds';

/**
 * How many files stand side by side, given how many the message holds.
 *
 * One keeps the row to itself. Two, and three, stand across. Four goes two and
 * two rather than three and a lonely one — a square reads as a set, a trailing
 * single reads as a mistake. Past four it is threes, so five is three then two
 * and six is three then three, and a message of a dozen is four tidy rows
 * rather than a column a scroll long.
 */
export function acrossFor(count: number): number {
  if (count <= 3) return count;
  if (count === 4) return 2;
  return 3;
}

/**
 * What a message from the agent shows above its words.
 *
 * His own message shows everything it carries, because he put it there and the
 * strip is the one he wrote it with. The agent's shows only what there is
 * something to look at: a picture, a video, a recording. A row of icons for
 * every file an agent mentioned would be a second, worse copy of what it
 * already said in words — the manager asked for exactly this split.
 */
export function shownFrom(role: 'user' | 'assistant', files: ImagePayload[]): ImagePayload[] {
  if (role === 'user') return files;
  return files.filter((file) => ['picture', 'video', 'audio'].includes(lookOf(file)));
}

/**
 * How wide the whole block may get, whatever the bubble around it allows.
 *
 * A message is words with files in it, not a gallery: past this the picture is
 * the message. Three across inside it still leaves each thumbnail wide enough
 * to recognise a screenshot by.
 */
const BLOCK = 'w-full max-w-[24rem]';

/** What every cell wears, however many of them there are. */
const THUMB =
  'block overflow-hidden rounded border border-border/60 transition-opacity hover:opacity-90';

export interface AttachmentGridProps {
  files: ImagePayload[];
  /** Open one whole, over the chat. */
  onLook: (image: ImagePayload) => void;
}

export function AttachmentGrid({ files, onLook }: AttachmentGridProps): JSX.Element | null {
  if (files.length === 0) return null;
  const across = acrossFor(files.length);
  const alone = files.length === 1;

  return (
    <div
      data-testid="attachment-grid"
      data-across={across}
      className={`mb-2 grid gap-1 ${BLOCK}`}
      // The column count is a number, not one of a handful of names, so it is
      // set here rather than as a class: Tailwind only ships the classes it can
      // read in the source, and `grid-cols-${across}` is not one of them.
      style={{ gridTemplateColumns: `repeat(${across}, minmax(0, 1fr))` }}
    >
      {files.map((file, i) => {
        const look = lookOf(file);
        const openable = opens(file);
        const press = openable ? () => onLook(file) : undefined;

        // A picture keeps the drawing it has always had, and the reason is a
        // layout one rather than a drawing one: a picture ALONE has a shape of
        // its own worth keeping, and a screenshot cropped for nothing is a
        // screenshot half lost. Nothing else in here has a shape — a zip is an
        // icon and a name at whatever size the cell is — so everything else
        // takes the common cell and `AttachmentFace` fills it.
        if (look === 'picture') {
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <Tooltip key={i} label="Click to see it full size">
              <img
                data-testid="message-image"
                src={attachmentSrc(file)}
                alt={file.alt}
                onClick={press}
                className={cn(
                  THUMB,
                  'cursor-zoom-in',
                  alone ? 'justify-self-start object-contain' : 'aspect-[4/3] w-full object-cover',
                )}
                style={alone ? inlineMediaBounds(file) : undefined}
              />
            </Tooltip>
          );
        }

        return (
          <Tooltip key={i} label={openable ? `${file.alt} — click to open it full size` : file.alt}>
            <Button
              type="button"
              variant="foreground"
              size="none"
              data-testid="message-attachment"
              data-file-kind={fileKind(file.alt)}
              data-look={look}
              aria-label={file.alt}
              onClick={press}
              disabled={!openable}
              className={cn(
                THUMB,
                'relative block aspect-[4/3] w-full p-0 text-left',
                openable ? 'cursor-zoom-in' : 'cursor-default',
              )}
            >
              <AttachmentFace file={file} />
            </Button>
          </Tooltip>
        );
      })}
    </div>
  );
}
