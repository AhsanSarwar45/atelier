import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * How the controls in a project's bar are spaced.
 *
 * The manager's own report, with a photograph of the bar on a phone: "gap
 * between back and home button is too much. it should be consistent with other
 * gaps" (bw-r8dg).
 *
 * One `gap-2` between every child of the bar is what produced three different
 * distances. An icon button is a 36px box around a 16px picture, so it carries
 * ten pixels of its own padding on each side: between two of them the eye sees
 * 8 + 10 + 10 = 28px, between one of them and the name 8 + 10 = 18px, and the
 * buttons at the end were given `gap-1` to paper over the difference. Equal
 * class names, unequal picture.
 *
 * So what is checked here is what the eye actually measures — the distance from
 * one drawn thing to the next drawn thing, along the whole bar — and that those
 * distances are all the same. The pictures are measured rather than the boxes,
 * because the boxes were never the complaint.
 *
 *   scripts/workbench-e2e.sh tests/e2e/the-project-bar-is-evenly-spaced.spec.ts
 */
const SHOTS = join(process.cwd(), 'tests', 'results');
const PHONE = { width: 390, height: 844 };

/** How far two neighbours in the bar may differ before the row reads as rough. */
const TOLERANCE = 3;

/** The smallest a control may be where the pointer is a thumb (globals.css). */
const TAP = 44;

test.use({ hasTouch: true, isMobile: true });

test('the bar leaves the same gap between each of its controls', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-bar-spacing');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'FirstPrinciples', path: fixture },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  try {
    await page.setViewportSize(PHONE);
    await page.goto(`/project?id=${project.id}`);
    const bar = page.getByTestId('project-bar');
    await expect(bar).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('project-name')).toHaveText(/FirstPrinciples/, {
      timeout: 60_000,
    });
    await expect(page.getByTestId('project-menu')).toBeVisible({ timeout: 60_000 });

    // Taken before anything is asserted, so a red run still leaves the picture
    // of the bar the manager was looking at.
    mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(500);
    await bar.screenshot({ path: join(SHOTS, 'project-bar-spacing.png') });

    // Each control named by what the reader sees of it: the picture inside the
    // button, not the button. The name is its own text. The run ends at the
    // project menu: what follows it is the free space of the bar, which is
    // meant to be there and is not a gap between neighbours.
    const RUN: { of: string; what: string; whole?: boolean }[] = [
      { of: 'back-arrow', what: 'the arrow' },
      { of: 'home-button', what: 'the home button' },
      // The name and the chevron beside it are one control and read as one
      // thing, so the pair is measured from the name's left edge to the
      // chevron's right rather than as two neighbours (bw-r8dg.2).
      { of: 'project-switch', what: 'the project name', whole: true },
      { of: 'project-menu', what: 'the project menu' },
    ];
    const drawn = [];
    for (const step of RUN) {
      const box = await page.getByTestId(step.of).evaluate((el, whole) => {
        const picture = whole ? el : (el.querySelector('svg') ?? el);
        const r = picture.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }, Boolean(step.whole));
      drawn.push({ ...step, ...box });
    }

    const gaps = drawn.slice(1).map((next, i) => ({
      between: `${drawn[i].what} and ${next.what}`,
      size: next.left - drawn[i].right,
    }));
    // The menu is the name's own, so it sits closer to the name than the bar's
    // other neighbours do: eight for the bar's gap and ten for the dots' own
    // padding, with none added after the name. At the full pitch it read as a
    // stray button, and on a phone it ran into the bell (the owner, bw-weih.10).
    const menuGap = gaps.pop()!;
    expect(menuGap.size, `${menuGap.between} are ${menuGap.size.toFixed(1)}px apart`).toBeGreaterThanOrEqual(18 - TOLERANCE);
    expect(menuGap.size, `${menuGap.between} are ${menuGap.size.toFixed(1)}px apart`).toBeLessThanOrEqual(18 + TOLERANCE);
    const widest = gaps.reduce((a, b) => (a.size > b.size ? a : b));
    const tightest = gaps.reduce((a, b) => (a.size < b.size ? a : b));
    expect(
      widest.size - tightest.size,
      `the bar is unevenly spaced: ${widest.size.toFixed(1)}px between ` +
        `${widest.between} but ${tightest.size.toFixed(1)}px between ${tightest.between} ` +
        `(all of them: ${gaps.map((g) => `${g.between} ${g.size.toFixed(1)}px`).join(', ')})`,
    ).toBeLessThanOrEqual(TOLERANCE);

    // What the tightening costs must not be the press itself. Each picture is
    // painted small and given an invisible band instead, so the reach is
    // checked rather than the paint — and each control must own its own
    // middle, because bands this close overlap at their edges.
    for (const step of RUN) {
      const control = page.getByTestId(step.of);
      const reach = await control.evaluate((el) => {
        const band = getComputedStyle(el, '::before');
        const box = el.getBoundingClientRect();
        const middle = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          tall: Math.max(box.height, parseFloat(band.height) || 0),
          wide: Math.max(box.width, parseFloat(band.width) || 0),
          ownsMiddle: el.contains(middle),
        };
      });
      expect(
        Math.round(reach.tall),
        `${step.what} is only ${Math.round(reach.tall)}px tall to a thumb`,
      ).toBeGreaterThanOrEqual(TAP);
      expect(
        Math.round(reach.wide),
        `${step.what} is only ${Math.round(reach.wide)}px wide to a thumb`,
      ).toBeGreaterThanOrEqual(TAP);
      // The name's own band is as wide as the name, which is wider than a
      // thumb here; what has to be checked of it is the height the floor was
      // turned off for.
      expect(reach.ownsMiddle, `a press on the middle of ${step.what} lands on a neighbour`).toBe(
        true,
      );
    }
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
