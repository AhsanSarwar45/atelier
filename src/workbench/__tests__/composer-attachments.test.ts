import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_LIMIT,
  imageIds,
  imageMarker,
  looksLikeAPicture,
  whyNot,
  promptFromDraft,
  promptParts,
  type DraftPicture,
} from '@/workbench/composer-attachments';

const one: DraftPicture = { id: 'one', mime: 'image/png', dataUrl: 'data:one', alt: 'first.png' };
const two: DraftPicture = { id: 'two', mime: 'image/png', dataUrl: 'data:two', alt: 'second.png' };

describe('image positions in a draft', () => {
  it('takes the marker out and writes nothing in its place', () => {
    const draft = `Compare ${imageMarker(one.id)} with ${imageMarker(two.id)} please`;
    // The app's own `[Image: name]` prose used to go in here, and the transcript
    // then read that prose back to decide whose words these were (bw-oamr.1).
    expect(promptFromDraft(draft, [one, two]).text).toBe('Compare  with  please');
  });

  it('says where each picture belongs as an offset into the words', () => {
    const draft = `Compare ${imageMarker(one.id)} with ${imageMarker(two.id)} please`;
    const { text, images } = promptFromDraft(draft, [one, two]);
    expect(images.map((picture) => picture.alt)).toEqual(['first.png', 'second.png']);
    expect(text.slice(0, images[0]!.at)).toBe('Compare ');
    expect(text.slice(0, images[1]!.at)).toBe('Compare  with ');
  });

  it('puts a picture attached before the first word at the very start', () => {
    // The case that disappeared: attach, then type. Nothing is left in front of
    // his words for the transcript to mistake for one of the kit's own notes.
    const draft = `${imageMarker(one.id)} what is wrong with this?`;
    const { text, images } = promptFromDraft(draft, [one]);
    expect(text).toBe('what is wrong with this?');
    expect(images[0]!.at).toBe(0);
  });

  it('orders pictures by where their badges occur', () => {
    const draft = `${imageMarker(two.id)} then ${imageMarker(one.id)}`;
    expect(imageIds(draft)).toEqual(['two', 'one']);
    expect(promptFromDraft(draft, [one, two]).images.map((picture) => picture.id)).toEqual(['two', 'one']);
    expect(promptParts(draft, [one, two])).toEqual([
      { type: 'image', id: 'two' },
      { type: 'text', text: ' then ' },
      { type: 'image', id: 'one' },
    ]);
  });

  it('keeps a picture whose badge was edited away, at the end', () => {
    const { text, images } = promptFromDraft('just words', [one]);
    expect(images.map((picture) => picture.id)).toEqual(['one']);
    expect(images[0]!.at).toBe(text.length);
  });

  // A message carrying pictures was refused outright once it grew past a couple
  // of megabytes, and half of that weight was this: the same base64 in `images`
  // and again inside `parts`. A part names its picture now (bw-ad3r.3).
  it('sends each picture once, however many places it is named', () => {
    const draft = `${imageMarker(one.id)} and again ${imageMarker(one.id)}`;
    const body = JSON.stringify({
      images: promptFromDraft(draft, [one, two]).images,
      parts: promptParts(draft, [one, two]),
    });
    expect(body.split('data:one').length - 1).toBe(1);
    expect(body.split('data:two').length - 1).toBe(1);
  });
});

// Android's own pickers hand back a file whose type is the empty string. The
// composer judged on that type alone, so the chooser opened, a picture was
// chosen, and nothing appeared at all (bw-ad3r.6).
describe('what the composer will take', () => {
  it('takes a picture the browser has described', () => {
    expect(looksLikeAPicture({ type: 'image/png', name: 'shot.png' })).toBe(true);
    expect(looksLikeAPicture({ type: 'image/heic', name: 'IMG_0001.HEIC' })).toBe(true);
  });

  it('takes a picture the phone said nothing about, by its name', () => {
    expect(looksLikeAPicture({ type: '', name: 'IMG_0001.HEIC' })).toBe(true);
    expect(looksLikeAPicture({ type: '', name: 'screenshot.PNG' })).toBe(true);
    expect(looksLikeAPicture({ name: 'photo.jpeg' })).toBe(true);
  });

  // Judging a file by its kind is how a video, an audio file, a PDF, a zip and
  // a spreadsheet all used to be dropped on the floor with a notice saying they
  // could go in a message "neither as a picture nor as words" (bw-oamr.6). What
  // a picture is still matters — only a picture has a shape to measure and only
  // a picture falls back to its own bytes when the store will not take it — but
  // it no longer decides what may be attached.
  it('still knows what is not a picture, without that deciding anything', () => {
    expect(looksLikeAPicture({ type: 'application/pdf', name: 'contract.pdf' })).toBe(false);
    expect(looksLikeAPicture({ type: '', name: 'notes.txt' })).toBe(false);
    expect(looksLikeAPicture({ type: '', name: '' })).toBe(false);
  });
});

// The writing box could only ever take pictures and files it could unroll into
// the draft as words: one paperclip, two hand-written extension lists, and
// nowhere for anything else to go (bw-ad3r.7, bw-oamr.6).
describe('what the writing box turns down', () => {
  it('takes every kind of file there is', () => {
    for (const name of ['clip.mp4', 'song.mp3', 'contract.pdf', 'bundle.zip', 'books.xlsx', 'notes.txt', 'thing.unheardof', 'README']) {
      expect(whyNot({ name, size: 10 })).toBeNull();
    }
  });

  it('turns down a file past the ceiling, by name and out loud', () => {
    const why = whyNot({ name: 'huge.mov', size: ATTACHMENT_LIMIT + 1 });
    expect(why).toContain('huge.mov');
    expect(why).toContain('100 MB');
  });

  it('turns down a file with nothing in it', () => {
    expect(whyNot({ name: 'empty.log', size: 0 })).toContain('empty.log');
  });

  it('takes a file right up to the ceiling', () => {
    expect(whyNot({ name: 'just-fits.zip', size: ATTACHMENT_LIMIT })).toBeNull();
  });
});
