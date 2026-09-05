/**
 * How big a picture is, read out of the picture itself.
 *
 * A chat carries its pictures in the record, so the bytes are already in hand —
 * but an `<img>` is laid out at nothing until the browser has decoded them, and
 * a row measured in that state is measured wrong. Every one of these formats
 * writes its width and height in the first few bytes, so the shape can be known
 * before the picture is drawn and the row can be given its full height from the
 * start (bw-cdav.3).
 *
 * Only the header is read. A picture that says nothing intelligible gets no
 * answer, and the caller falls back to letting the browser decide.
 */

export interface PictureShape {
  width: number;
  height: number;
}

/** Enough of the front of the file for any of the headers below. */
const ENOUGH = 65_536;

function bytesOf(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) return null;
  // Whole groups of four, because base64 does not decode by halves.
  const front = dataUrl.slice(comma + 1, comma + 1 + ENOUGH);
  const whole = front.slice(0, front.length - (front.length % 4));
  if (whole.length === 0) return null;
  try {
    const raw = atob(whole);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function says(b: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i += 1) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

const be32 = (b: Uint8Array, at: number): number =>
  (b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!;
const le16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const le24 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

function png(b: Uint8Array): PictureShape | null {
  if (b.length < 24 || b[0] !== 0x89 || !says(b, 1, 'PNG')) return null;
  // The IHDR is required to come first, so its width and height are at a fixed
  // place: eight bytes of signature, four of length, four of type.
  return { width: be32(b, 16), height: be32(b, 20) };
}

function gif(b: Uint8Array): PictureShape | null {
  if (b.length < 10 || !says(b, 0, 'GIF8')) return null;
  return { width: le16(b, 6), height: le16(b, 8) };
}

function jpeg(b: Uint8Array): PictureShape | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  // The size lives in whichever start-of-frame marker comes first, and how far
  // in that is depends on how much the encoder put before it.
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = b[at + 1]!;
    // Padding and the markers that carry nothing after them.
    if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = (b[at + 2]! << 8) | b[at + 3]!;
    const frame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (frame) return { width: (b[at + 7]! << 8) | b[at + 8]!, height: (b[at + 5]! << 8) | b[at + 6]! };
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function webp(b: Uint8Array): PictureShape | null {
  if (b.length < 30 || !says(b, 0, 'RIFF') || !says(b, 8, 'WEBP')) return null;
  if (says(b, 12, 'VP8X')) return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  if (says(b, 12, 'VP8L')) {
    // Fourteen bits each, packed into the four bytes after the signature byte.
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (says(b, 12, 'VP8 ')) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  return null;
}

/** The picture's own size, or nothing if its header does not say. */
export function pictureShape(dataUrl: string): PictureShape | null {
  const b = bytesOf(dataUrl);
  if (!b) return null;
  const shape = png(b) ?? gif(b) ?? webp(b) ?? jpeg(b);
  if (!shape || shape.width <= 0 || shape.height <= 0) return null;
  return shape;
}
