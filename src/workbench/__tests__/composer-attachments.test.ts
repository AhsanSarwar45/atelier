import { describe, expect, it } from 'vitest';

import {
  fileAsABlock,
  imageIds,
  imageMarker,
  looksLikeAPicture,
  looksLikeText,
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

  it('turns down what is not a picture, rather than dropping it in silence', () => {
    expect(looksLikeAPicture({ type: 'application/pdf', name: 'contract.pdf' })).toBe(false);
    expect(looksLikeAPicture({ type: '', name: 'notes.txt' })).toBe(false);
    expect(looksLikeAPicture({ type: '', name: '' })).toBe(false);
  });
});

// The writing box could only ever take pictures: one paperclip, accepting
// image/*, and nowhere for anything else to go (bw-ad3r.7).
describe('a file that is not a picture', () => {
  it('is recognised as words by its type, or by its name when there is none', () => {
    expect(looksLikeText({ type: 'text/plain', name: 'notes.txt' })).toBe(true);
    expect(looksLikeText({ type: 'application/json', name: 'package.json' })).toBe(true);
    expect(looksLikeText({ type: '', name: 'main.rs' })).toBe(true);
    expect(looksLikeText({ type: '', name: 'photo.jpg' })).toBe(false);
    expect(looksLikeText({ type: 'application/pdf', name: 'contract.pdf' })).toBe(false);
  });

  it('goes into the draft as a block that names it', () => {
    expect(fileAsABlock('notes.txt', 'one\ntwo\n')).toBe('notes.txt:\n```txt\none\ntwo\n```\n');
  });

  // A markdown file carrying its own code blocks would otherwise end the
  // block early and spill the rest of itself into the message as prose.
  it('is fenced wider than any run of backticks inside it', () => {
    const given = 'before\n```js\nconst a = 1;\n```\nafter';
    const block = fileAsABlock('readme.md', given);
    expect(block.startsWith('readme.md:\n````md\n')).toBe(true);
    expect(block.endsWith('\n````\n')).toBe(true);
    expect(block).toContain('```js');
  });
});
