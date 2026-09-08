import { crc32, deflateSync } from 'node:zlib';

/**
 * A real PNG, encoded here rather than committed as a binary or pulled from a
 * library: the test needs a picture that is obviously a picture on screen, and
 * one it can regenerate byte-for-byte.
 */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** Four coloured quadrants, so it is unmistakable in a screenshot. */
export function quadrantPng(size = 120): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const right = x >= size / 2;
      const bottom = y >= size / 2;
      const [r, g, b] = bottom
        ? right
          ? [250, 204, 21]
          : [34, 197, 94]
        : right
          ? [59, 130, 246]
          : [239, 68, 68];
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A big picture with a fine grid on it, for proving a zoom is anchored.
 *
 * "The pixel under the pointer stayed under the pointer" is a claim about one
 * point, and a flat colour cannot carry it: the eye needs a landmark it can
 * find again after the scale changed. So this is ruled every `step` pixels,
 * with a heavier line every fifth one and the colour walking across the
 * picture, which makes every crossing distinguishable from every other. It is
 * also deliberately larger than any viewport, so the picture overflows its box
 * and there is somewhere to pan to.
 */
export function ruledPng(width: number, height: number, step = 40): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const major = x % (step * 5) === 0 || y % (step * 5) === 0;
      const minor = x % step === 0 || y % step === 0;
      if (major) {
        raw[o++] = 17; raw[o++] = 17; raw[o++] = 17;
      } else if (minor) {
        raw[o++] = 120; raw[o++] = 120; raw[o++] = 130;
      } else {
        raw[o++] = 235 - Math.floor((x / width) * 120);
        raw[o++] = 240 - Math.floor((y / height) * 130);
        raw[o++] = 250 - Math.floor(((x + y) / (width + height)) * 90);
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
