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
      { type: 'image', image: two },
      { type: 'text', text: ' then ' },
      { type: 'image', image: one },
    ]);
  });
});
