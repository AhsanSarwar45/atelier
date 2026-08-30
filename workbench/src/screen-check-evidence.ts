import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export type StaticEvidence = {
  source: 'image' | 'window';
  dimensions: { width: number; height: number } | null;
  visible_text: { source: 'vision-required'; text: '' };
  accessibility: null;
};

export type PixelComparison = {
  method: 'pixelmatch';
  threshold: number;
  aligned: boolean;
  alignment: { basis: 'equal-pixel-dimensions'; width?: number; height?: number; reason?: string };
  changed_pixels?: number;
  total_pixels?: number;
  difference_ratio?: number;
  diff?: Buffer;
};

export function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function staticEvidence(source: 'image' | 'window', bytes: Buffer): StaticEvidence {
  return { source, dimensions: pngDimensions(bytes), visible_text: { source: 'vision-required', text: '' }, accessibility: null };
}

export function comparePng(before: Buffer, after: Buffer, threshold = 0.1): PixelComparison {
  let left: PNG; let right: PNG;
  try { left = PNG.sync.read(before); right = PNG.sync.read(after); }
  catch { return { method: 'pixelmatch', threshold, aligned: false, alignment: { basis: 'equal-pixel-dimensions', reason: 'both inputs must be valid PNG images' } }; }
  if (left.width !== right.width || left.height !== right.height) return { method: 'pixelmatch', threshold, aligned: false,
    alignment: { basis: 'equal-pixel-dimensions', width: left.width, height: left.height, reason: `dimension mismatch: ${left.width}x${left.height} versus ${right.width}x${right.height}` } };
  const diff = new PNG({ width: left.width, height: left.height });
  const changed = pixelmatch(left.data, right.data, diff.data, left.width, left.height, { threshold, includeAA: false }); const total = left.width * left.height;
  return { method: 'pixelmatch', threshold, aligned: true, alignment: { basis: 'equal-pixel-dimensions', width: left.width, height: left.height },
    changed_pixels: changed, total_pixels: total, difference_ratio: total ? changed / total : 0, diff: PNG.sync.write(diff) };
}
