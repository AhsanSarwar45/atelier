/**
 * What one attachment can be shown as, and which of its two names decides.
 */
import { describe, it, expect } from 'vitest';

import { lookOf, opens } from '@/workbench/attachment-look';

describe('what an attachment can be shown as', () => {
  it('reads the ending of a name', () => {
    expect(lookOf('shot.png')).toBe('picture');
    expect(lookOf('clip.mp4')).toBe('video');
    expect(lookOf('song.mp3')).toBe('audio');
    expect(lookOf('contract.pdf')).toBe('pdf');
    expect(lookOf('notes.txt')).toBe('words');
    expect(lookOf('bundle.zip')).toBe('nothing');
  });

  it('is not fooled by the case of the ending', () => {
    expect(lookOf('SHOT.PNG')).toBe('picture');
  });

  // A picture out of a chat's own record is called `Picture 1` and has no
  // ending at all, so a look worked out from the name alone called it
  // unopenable and clicking it showed the reader nothing.
  it('takes the type the record carried over the name it was given', () => {
    expect(lookOf({ alt: 'Picture 1', mime: 'image/png' })).toBe('picture');
    expect(lookOf({ alt: 'Attachment 2', mime: 'video/webm' })).toBe('video');
    expect(lookOf({ alt: 'no ending here', mime: 'application/pdf' })).toBe('pdf');
  });

  // Android's Drive, Files and Downloads providers hand back a file whose type
  // is the empty string, so the name has to be able to answer on its own.
  it('falls back to the name when nothing said what the file was', () => {
    expect(lookOf({ alt: 'holiday.jpeg' })).toBe('picture');
    expect(lookOf({ alt: 'holiday.jpeg', mime: '' })).toBe('picture');
  });

  it('says what opening would show the reader something', () => {
    expect(opens('shot.png')).toBe(true);
    expect(opens('bundle.zip')).toBe(false);
    expect(opens({ alt: 'Picture 1', mime: 'image/png' })).toBe(true);
  });
});
