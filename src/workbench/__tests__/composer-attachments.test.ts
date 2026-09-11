import { describe, expect, it } from 'vitest';

import {
  imageIds,
  imageMarker,
  looksLikeAPicture,
  orderedPictures,
  promptParts,
  promptWithoutImageMarkers,
  type DraftPicture,
} from '@/workbench/composer-attachments';

const one: DraftPicture = { id: 'one', mime: 'image/png', dataUrl: 'data:one', alt: 'first.png' };
const two: DraftPicture = { id: 'two', mime: 'image/png', dataUrl: 'data:two', alt: 'second.png' };

describe('image positions in a draft', () => {
  it('keeps the visible marker out of the words sent to the agent', () => {
    const draft = `Compare ${imageMarker(one.id)} with ${imageMarker(two.id)} please`;
    expect(promptWithoutImageMarkers(draft, [one, two])).toBe('Compare [Image: first.png] with [Image: second.png] please');
  });

  it('orders pictures by where their badges occur', () => {
    const draft = `${imageMarker(two.id)} then ${imageMarker(one.id)}`;
    expect(imageIds(draft)).toEqual(['two', 'one']);
    expect(orderedPictures(draft, [one, two])).toEqual([two, one]);
    expect(promptParts(draft, [one, two])).toEqual([
      { type: 'image', id: 'two' },
      { type: 'text', text: ' then ' },
      { type: 'image', id: 'one' },
    ]);
  });

  // A message carrying pictures was refused outright once it grew past a couple
  // of megabytes, and half of that weight was this: the same base64 in `images`
  // and again inside `parts`. A part names its picture now (bw-ad3r.3).
  it('sends each picture once, however many places it is named', () => {
    const draft = `${imageMarker(one.id)} and again ${imageMarker(one.id)}`;
    const body = JSON.stringify({
      images: orderedPictures(draft, [one, two]),
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

  it('turns down what is not a picture, rather than dropping it in silence', () => {
    expect(looksLikeAPicture({ type: 'application/pdf', name: 'contract.pdf' })).toBe(false);
    expect(looksLikeAPicture({ type: '', name: 'notes.txt' })).toBe(false);
    expect(looksLikeAPicture({ type: '', name: '' })).toBe(false);
  });
});
