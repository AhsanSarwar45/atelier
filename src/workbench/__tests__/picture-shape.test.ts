/**
 * Reading a picture's size out of its first few bytes.
 *
 * The chat needs the shape before the browser has decoded anything, so it reads
 * the header itself. Each format is built here by hand rather than taken from a
 * file, so what is being asserted is the byte layout and not a fixture.
 */
import { describe, expect, it } from 'vitest';

import { pictureShape } from '../picture-shape';

function url(bytes: Buffer, mime = 'image/png'): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(10);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

/** A JPEG with a comment ahead of the frame, so the walk has to walk. */
function jpeg(width: number, height: number): Buffer {
  const head = Buffer.from([0xff, 0xd8]);
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x06]), Buffer.from('four')]);
  const frame = Buffer.alloc(11);
  frame.writeUInt16BE(0xffc0, 0);
  frame.writeUInt16BE(9, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([head, comment, frame, Buffer.alloc(16)]);
}

function riff(kind: string, body: Buffer): Buffer {
  const b = Buffer.alloc(12 + 8 + body.length);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(4 + 8 + body.length, 4);
  b.write('WEBP', 8, 'ascii');
  b.write(kind, 12, 'ascii');
  b.writeUInt32LE(body.length, 16);
  body.copy(b, 20);
  return b;
}

describe('the size a picture says it is', () => {
  it('reads a PNG out of its header', () => {
    expect(pictureShape(url(png(1280, 720)))).toEqual({ width: 1280, height: 720 });
  });

  it('reads a GIF, which writes its size the other way round', () => {
    expect(pictureShape(url(gif(300, 200), 'image/gif'))).toEqual({ width: 300, height: 200 });
  });

  it('walks a JPEG past whatever the encoder put before the frame', () => {
    expect(pictureShape(url(jpeg(1024, 768), 'image/jpeg'))).toEqual({ width: 1024, height: 768 });
  });

  it('reads an extended WebP, whose size is a pair of three-byte counts', () => {
    const body = Buffer.alloc(18);
    body.writeUIntLE(1919, 4, 3);
    body.writeUIntLE(1079, 7, 3);
    expect(pictureShape(url(riff('VP8X', body), 'image/webp'))).toEqual({ width: 1920, height: 1080 });
  });

  it('reads a lossless WebP, whose size is packed into fourteen bits each', () => {
    const body = Buffer.alloc(24);
    body[0] = 0x2f;
    body.writeUInt32LE(((640 - 1) & 0x3fff) | (((480 - 1) & 0x3fff) << 14), 1);
    expect(pictureShape(url(riff('VP8L', body), 'image/webp'))).toEqual({ width: 640, height: 480 });
  });

  it('reads a lossy WebP, which hides its size behind a start code', () => {
    const body = Buffer.alloc(24);
    body[3] = 0x9d;
    body[4] = 0x01;
    body[5] = 0x2a;
    body.writeUInt16LE(800, 6);
    body.writeUInt16LE(600, 8);
    expect(pictureShape(url(riff('VP8 ', body), 'image/webp'))).toEqual({ width: 800, height: 600 });
  });

  it('says nothing about anything it does not recognise, rather than guessing', () => {
    expect(pictureShape('data:image/png;base64,bm90IGEgcGljdHVyZSBhdCBhbGw=')).toBeNull();
    expect(pictureShape('https://example.test/picture.png')).toBeNull();
    expect(pictureShape('data:image/png,not-base64-at-all')).toBeNull();
    expect(pictureShape('')).toBeNull();
  });

  it('says nothing about a header that claims no size', () => {
    expect(pictureShape(url(png(0, 0)))).toBeNull();
  });
});
