/**
 * A hue for anything a chip names and the theme has no opinion about — a
 * folder, a machine — so one name keeps one colour wherever it is drawn, and
 * two of them never read as the same thing.
 */
const HUES: readonly number[] = [199, 152, 275, 20, 96, 320, 245, 172, 62, 350, 128, 296];

function hash(text: string): number {
  let acc = 0;
  for (let i = 0; i < text.length; i += 1) {
    acc = (acc * 31 + text.charCodeAt(i)) >>> 0;
  }
  return acc;
}

/** The hue, in degrees, a name is drawn in. */
export function hueFor(name: string): number {
  return HUES[hash(name) % HUES.length];
}
