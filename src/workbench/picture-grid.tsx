/**
 * The pictures of one message, laid out the way a chat app lays pictures out.
 *
 * Stacked one under another at full bubble width, two screenshots pushed the
 * words of the message off the screen and a message of five was a page of its
 * own — which is what the manager was looking at (bw-uu9x.10). Every messaging
 * app answers this the same way: the pictures of one message are a block, the
 * block is held to a width, and how many stand side by side follows how many
 * there are.
 *
 * The block is a thumbnail and nothing more. Clicking any picture in it opens
 * that picture whole, which is what makes cropping a cell safe.
 */
import type { ImagePayload } from '@/workbench/protocol';

/**
 * How many pictures stand side by side, given how many the message holds.
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
 * How wide the whole block may get, whatever the bubble around it allows.
 *
 * A message is words with pictures in it, not a gallery: past this the picture
 * is the message. Three across inside it still leaves each thumbnail wide
 * enough to recognise a screenshot by.
 */
const BLOCK = 'w-full max-w-[24rem]';

/** What every thumbnail wears, however many of them there are. */
const THUMB =
  'cursor-zoom-in rounded border border-border/60 transition-opacity hover:opacity-90';

export interface PictureGridProps {
  images: ImagePayload[];
  /** Open one whole, over the chat. */
  onLook: (image: ImagePayload) => void;
}

export function PictureGrid({ images, onLook }: PictureGridProps): JSX.Element | null {
  if (images.length === 0) return null;
  const across = acrossFor(images.length);
  const alone = images.length === 1;

  return (
    <div
      data-testid="picture-grid"
      data-across={across}
      className={`mb-2 grid gap-1 ${BLOCK}`}
      // The column count is a number, not one of a handful of names, so it is
      // set here rather than as a class: Tailwind only ships the classes it can
      // read in the source, and `grid-cols-${across}` is not one of them.
      style={{ gridTemplateColumns: `repeat(${across}, minmax(0, 1fr))` }}
    >
      {images.map((img, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={i}
          data-testid="message-image"
          src={img.dataUrl}
          alt={img.alt}
          title="Click to see it full size"
          onClick={() => onLook(img)}
          // A picture on its own keeps its own shape — there is no neighbour for
          // it to line up with, and a screenshot cropped for nothing is a
          // screenshot half lost. Two or more crop to a common shape, because a
          // row of mixed heights reads as a mess and the whole picture is one
          // click away regardless.
          className={
            alone
              ? `${THUMB} max-h-48 w-auto justify-self-start object-contain`
              : `${THUMB} aspect-[4/3] w-full object-cover`
          }
        />
      ))}
    </div>
  );
}
