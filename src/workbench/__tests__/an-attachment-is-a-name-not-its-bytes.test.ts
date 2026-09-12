/**
 * An attachment travels as the name of a kept file, not as its bytes
 * (bw-oamr.5).
 *
 * A picture used to ride base64 inside the message, and the message is what
 * the event log keeps: so every browser was handed the whole picture again on
 * every snapshot, and the chat database held it for good. That is survivable
 * for a screenshot and ruinous for a video, which is the thing this job is
 * about to start accepting.
 *
 * So the bytes are kept once in the app's content-addressed store and the
 * message carries the name they were kept under. These are the two halves of
 * that promise: what is sent no longer holds the bytes, and what is drawn
 * still knows where to find them.
 */
import { describe, expect, it } from 'vitest';

import { attachmentSrc } from '@/workbench/attachment-store';
import { promptFromDraft, type DraftPicture } from '@/workbench/composer-attachments';
import { inlineMediaBounds } from '@/workbench/media-bounds';

const BYTES = 'data:image/png;base64,iVBORw0KGgo=';

const kept = (over: Partial<DraftPicture> = {}): DraftPicture => ({
  id: 'one',
  mime: 'image/png',
  dataUrl: BYTES,
  alt: 'shot.png',
  asset: `${'a'.repeat(64)}.png`,
  ...over,
});

describe('what is sent', () => {
  it('leaves a kept picture’s bytes behind', () => {
    const { images } = promptFromDraft('look [[atelier-image:one]]', [kept()]);
    expect(images).toHaveLength(1);
    expect(images[0]!.asset).toBe(`${'a'.repeat(64)}.png`);
    expect(images[0]!.dataUrl, 'the bytes went out with the message anyway').toBe('');
  });

  it('keeps the bytes of a picture the store never took', () => {
    // The store refusing is not a reason to lose the picture: without its own
    // bytes there would be nothing left of it at all.
    const { images } = promptFromDraft('look [[atelier-image:one]]', [kept({ asset: undefined })]);
    expect(images[0]!.dataUrl).toBe(BYTES);
  });

  it('still says where the picture sat in the words', () => {
    const { text, images } = promptFromDraft('before [[atelier-image:one]] after', [kept()]);
    expect(text).toBe('before  after');
    expect(images[0]!.at).toBe('before '.length);
  });
});

describe('what is drawn', () => {
  it('fetches a kept picture from the store', () => {
    expect(attachmentSrc(kept())).toContain(`/api/presentation-assets/${'a'.repeat(64)}.png`);
  });

  it('uses the bytes of anything written before there was a store', () => {
    expect(attachmentSrc({ dataUrl: BYTES })).toBe(BYTES);
  });

  it('holds a kept picture’s place open from its recorded shape', () => {
    // Nothing here can read a header any more, so a picture with no recorded
    // shape is the one that jumps (bw-cdav.3) — hence it is carried.
    const sized = inlineMediaBounds({ dataUrl: '', width: 600, height: 300 });
    expect(sized.aspectRatio).toBe('600 / 300');
    expect(sized.width).toBe('600px');
    // A tall one is brought down by the cap on height, exactly as it was when
    // the shape was read out of the bytes.
    const tall = inlineMediaBounds({ dataUrl: '', width: 800, height: 400 });
    expect(tall.width).toBe('768px');
    // And with no shape at all it falls back to what it did before.
    expect(inlineMediaBounds({ dataUrl: '' }).width).toBe('auto');
  });
});
