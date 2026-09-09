import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One stage answers to the picture stage's name (bw-e3dw.15).
 *
 * An SVG could not be zoomed by any pointer for as long as this file did not
 * exist. `file-preview.tsx` drew the `image` kind through `ImagePreview`, which
 * holds `useZoomPan` and gives a wheel, a drag and a transform — and drew the
 * `svg` kind a few lines below as a second, hand-rolled stage: a plain `<img>`
 * in an `overflow-auto` box with no handlers at all.
 *
 * The reason no case caught that is the interesting part, and it is what this
 * one is here to stop happening again. Both stages carried the SAME
 * `data-testid="file-preview-image-stage"`, so every spec that asked for the
 * stage got whichever one the file kind it opened happened to render. The zoom
 * specs opened a PNG and passed; the frozen stage sat behind the same name,
 * indistinguishable, for as long as nobody opened an SVG by hand.
 *
 * A name that two different things answer to cannot be asserted about. So the
 * rule is that exactly one place in the source renders each of these, and a
 * second stage under the same name is this test going red rather than a
 * feature quietly missing from half the files in the app.
 */

/** What a stage must carry to be one: the live state of the gesture. */
const PROOF = ['data-scale', 'data-pan-x', 'data-pannable'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

function rendering(what: string): { file: string; text: string }[] {
  const root = join(process.cwd(), 'src');
  return sourceFiles(root)
    .filter((path) => !path.endsWith('one-picture-stage.test.ts'))
    .map((path) => ({ file: relative(root, path), text: readFileSync(path, 'utf8') }))
    .filter(({ text }) => text.includes(`data-testid="${what}"`));
}

describe('one picture stage', () => {
  it.each(['file-preview-image-stage', 'file-preview-image'])('is rendered in exactly one place: %s', (name) => {
    expect(
      rendering(name).map(({ file }) => file),
      `${name} is drawn in more than one place, so a spec asking for it gets whichever one the file kind rendered`,
    ).toEqual(['workbench/file-preview.tsx']);
  });

  it('is the stage the gesture is actually attached to', () => {
    const [only] = rendering('file-preview-image-stage');
    // Within the same element: the attributes only a live `useZoomPan` can
    // supply. A hand-rolled div could not answer these, which is precisely how
    // a frozen stage would now be told apart from a working one.
    const stage = only.text.slice(only.text.indexOf('data-testid="file-preview-image-stage"'));
    const element = stage.slice(0, stage.indexOf('>'));
    for (const attribute of PROOF) expect(element, `the stage does not report ${attribute}`).toContain(attribute);
  });
});
