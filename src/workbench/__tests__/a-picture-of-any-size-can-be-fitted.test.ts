import { describe, expect, it } from 'vitest';

import { steppedZoom } from '@/workbench/file-preview';
import { fitScale } from '@/workbench/zoom-pan';

/**
 * A zoom floor is a relative number wearing an absolute one's clothes
 * (bw-e3dw.17).
 *
 * The owner met it in the running app: "for images we arent able to zoom out
 * below 25%, large images cant be fit into view as such". The floor was
 * `ZOOMS[0]`, a constant, and whether a constant is far enough out depends on
 * the picture's size against the stage — which is exactly the thing a constant
 * cannot know. The sizes below are the ones from the report: a phone stage, and
 * pictures that clear the old floor, miss it, and miss it by a factor of eight.
 */

/** The Files tab's stage on a 390px phone, and on a desktop pane. */
const PHONE = { width: 390, height: 620 };
const DESKTOP = { width: 1000, height: 700 };

/** What file-preview derives, kept in one line so the shape of it is visible. */
const floor = (stage: { width: number; height: number }, picture: { width: number; height: number }) =>
  Math.min(0.25, fitScale(stage, picture));

describe('how far out a picture may be zoomed', () => {
  it('is the scale that fits it, whenever that is further out than the ladder goes', () => {
    // 1200 wide on a 390 stage: the old fixed floor happened to clear it.
    expect(fitScale(PHONE, { width: 1200, height: 900 })).toBeCloseTo(0.325, 3);
    expect(floor(PHONE, { width: 1200, height: 900 })).toBe(0.25);

    // 4000 and 12000 wide: the two the owner could not fit at all.
    expect(fitScale(PHONE, { width: 4000, height: 3000 })).toBeCloseTo(0.0975, 4);
    expect(floor(PHONE, { width: 4000, height: 3000 })).toBeCloseTo(0.0975, 4);
    expect(floor(PHONE, { width: 12000, height: 9000 })).toBeCloseTo(0.0325, 4);
  });

  it('lets the long side decide, so nothing is cropped to make it fit', () => {
    // Tall and narrow: the height is the binding constraint, not the width.
    expect(fitScale(PHONE, { width: 400, height: 6200 })).toBeCloseTo(0.1, 6);
    expect(fitScale(DESKTOP, { width: 4000, height: 700 })).toBeCloseTo(0.25, 6);
  });

  it('never goes below the ladder for a picture that already fits', () => {
    // A 32px icon on a desktop pane fits many times over. Zooming out further
    // than the ladder would only make it smaller for no reason.
    expect(fitScale(DESKTOP, { width: 32, height: 32 })).toBeGreaterThan(1);
    expect(floor(DESKTOP, { width: 32, height: 32 })).toBe(0.25);
  });

  it('is the fixed floor until the numbers are real, never zero', () => {
    // Before layout, and before the picture has loaded, an unmeasured box
    // answers 1 — so the floor is the ladder's, not nothing at all.
    expect(fitScale({ width: 0, height: 0 }, { width: 4000, height: 3000 })).toBe(1);
    expect(fitScale(PHONE, null)).toBe(1);
    expect(floor({ width: 0, height: 0 }, { width: 4000, height: 3000 })).toBe(0.25);
  });
});

describe('stepping the ladder', () => {
  const min = 0.0325;
  const max = 8;

  it('reaches the derived floor by pressing zoom out, not only by pressing Fit', () => {
    // From the smallest rung there is no rung below, so the next press is the
    // floor itself. The old version indexed the ladder and clamped, so it
    // could not leave 25% at all.
    expect(steppedZoom(0.25, -1, min, max)).toBeCloseTo(min, 6);
    expect(steppedZoom(min, -1, min, max)).toBeCloseTo(min, 6);
  });

  it('comes back up to the rung above where it is, not past it', () => {
    expect(steppedZoom(min, 1, min, max)).toBe(0.25);
    expect(steppedZoom(0.0975, 1, min, max)).toBe(0.25);
    expect(steppedZoom(0.25, 1, min, max)).toBe(0.5);
  });

  it('still walks the round percentages in the middle, and stops at the top', () => {
    expect(steppedZoom(1, 1, 0.25, max)).toBe(1.5);
    expect(steppedZoom(1, -1, 0.25, max)).toBe(0.75);
    expect(steppedZoom(8, 1, 0.25, max)).toBe(8);
    // Somewhere off the ladder, where the wheel leaves it.
    expect(steppedZoom(1.7, 1, 0.25, max)).toBe(2);
    expect(steppedZoom(1.7, -1, 0.25, max)).toBe(1.5);
  });
});
