import { describe, expect, it } from 'vitest';

import {
  imageIds,
  imageMarker,
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
