import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { ruledPng } from './fixture-png';

/**
 * A picture of any size can be zoomed out until the whole of it is in the room
 * (bw-e3dw.17).
 *
 * The owner, from the running app: "for images we arent able to zoom out below
 * 25%, large images cant be fit into view as such, we need much more zoom out".
 * The floor was `ZOOMS[0]`, a constant — and a constant is an absolute answer
 * to a relative question. A 4000px picture on a 390px phone stage needs 0.0975
 * to fit, so 25% was not a floor the reader could stop at, it was a wall they
 * stopped against.
 *
 * The claim is therefore not "the number went lower". It is that after asking,
 * the drawn picture is INSIDE the stage — measured as two boxes on the glass,
 * on a phone and on a desktop, because the stage is the other half of the
 * question and it is a different size in each.
 *
 * The picture opens at its real pixel size, and that is kept: bw-e3dw.5 and
 * bw-e3dw.15 both recorded it deliberately, and it is precisely why a reachable
 * fit is necessary rather than optional. So the first thing each case measures
 * is that the picture opened larger than the room.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-picture-of-any-size-fits-the-view.spec.ts
 */

/** Where this case's evidence goes; the run script points it at a fresh dir. */
const SHOTS = join(__dirname, '..', 'results', 'picture-fits', process.env.FITS_RUN ?? 'run');
const WAIT = 60_000;

/**
 * Four times the width of a phone stage and well past the old floor: at 25% a
 * 4000px picture is still 1000px wide, which is two and a half phone screens.
 */
const BIG = { width: 4000, height: 3000 };

test.setTimeout(240_000);

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

/** Test projects are hidden by default; this page wants to see its own. */
async function showTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

/** A project holding one very large picture, opened in the Files tab. */
async function openTheBigPicture(page: Page, request: APIRequestContext, where: string) {
  await showTestProjects(page);
  rmSync(where, { recursive: true, force: true });
  mkdirSync(where, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Atelier Tester');
  git(where, 'config', 'user.email', 'tester@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'commit', '-qm', 'seed', '--allow-empty');
  const huge = join(where, 'huge.png');
  writeFileSync(huge, ruledPng(BIG.width, BIG.height));

  const project = await fixtureProject(request, `fits-${process.pid}-${where.slice(-6)}`, where);
  await page.goto(`/project?id=${project.id}&tab=files&file=${encodeURIComponent(huge)}`);
  await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'image', { timeout: WAIT });
  await expect(page.getByTestId('file-preview-dimensions')).toHaveText(`${BIG.width} × ${BIG.height}`, { timeout: WAIT });
}

/** The two boxes the whole card is about: the picture as drawn, and its room. */
async function measured(page: Page) {
  const stage = (await page.getByTestId('file-preview-image-stage').boundingBox())!;
  const drawn = (await page.getByTestId('file-preview-image').boundingBox())!;
  const scale = Number(await page.getByTestId('file-preview-image-stage').getAttribute('data-scale'));
  return { stage, drawn, scale };
}

function say(what: string, m: Awaited<ReturnType<typeof measured>>): string {
  return `${what}: ${Math.round(m.scale * 1000) / 10}% — the picture is drawn `
    + `${Math.round(m.drawn.width)}×${Math.round(m.drawn.height)} in a stage of `
    + `${Math.round(m.stage.width)}×${Math.round(m.stage.height)}`;
}

/**
 * Zoom out by pressing zoom-out, until pressing it stops changing anything.
 *
 * This is the reader's own route to the floor and it works whichever floor the
 * app has, which is what makes it the measurement that can be taken before the
 * change as well as after. Twenty presses is far more than the ladder is long.
 */
async function zoomedAllTheWayOut(page: Page) {
  const out = page.getByRole('button', { name: 'Zoom out' });
  let last = Number.NaN;
  for (let press = 0; press < 20; press += 1) {
    const now = (await measured(page)).scale;
    if (now === last) break;
    last = now;
    await out.click();
    await page.waitForTimeout(40);
  }
  return measured(page);
}

/**
 * What each case leaves behind, so before and after can be read side by side.
 *
 * One file per case rather than one for the run: the four cases are four
 * workers in four processes, and a single shared file is whichever of them
 * wrote last.
 */
function record(into: string, line: string): void {
  mkdirSync(SHOTS, { recursive: true });
  appendFileSync(join(SHOTS, `measurements-${into}.txt`), `${line}\n`);
}

for (const screen of [
  { name: 'a phone', dir: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: 'a desktop', dir: 'desktop', viewport: { width: 1440, height: 900 }, hasTouch: false },
] as const) {
  test.describe(`on ${screen.name}`, () => {
    test.use({ viewport: screen.viewport, hasTouch: screen.hasTouch, deviceScaleFactor: 2 });

    test(`records how far out a ${BIG.width}px picture can be taken on ${screen.name}`, async ({ page, request }) => {
      await openTheBigPicture(page, request, join(__dirname, '..', `.picture-fits-${screen.dir}-record`));

      // It opens at its real pixel size, which is the decision this card keeps.
      const opened = await measured(page);
      expect(opened.scale, 'the picture did not open at its real pixel size').toBeCloseTo(1, 3);
      expect(opened.drawn.width, 'the picture did not open larger than its room').toBeGreaterThan(opened.stage.width);
      record(`${screen.dir}-record`, say(`${screen.name}, opened`, opened));
      await page.screenshot({ path: join(SHOTS, `${screen.dir}-opened.png`), animations: 'disabled' });

      const out = await zoomedAllTheWayOut(page);
      record(`${screen.dir}-record`, say(`${screen.name}, zoomed out as far as the app allows`, out));
      await page.screenshot({ path: join(SHOTS, `${screen.dir}-zoomed-out.png`), animations: 'disabled' });
    });

    test(`fits a ${BIG.width}px picture into the stage on ${screen.name}`, async ({ page, request }) => {
      await openTheBigPicture(page, request, join(__dirname, '..', `.picture-fits-${screen.dir}-judge`));
      const opened = await measured(page);

      // 1. Zooming out on its own reaches a fit. This is the owner's own route
      //    — press the minus until it stops — and it is the one that failed.
      const out = await zoomedAllTheWayOut(page);
      expect(out.drawn.width, say('zoomed out, the picture is still wider than its room', out))
        .toBeLessThanOrEqual(out.stage.width + 1);
      expect(out.drawn.height, say('zoomed out, the picture is still taller than its room', out))
        .toBeLessThanOrEqual(out.stage.height + 1);

      // 2. And the whole of it is there: fitting is not cropping. The long side
      //    touches its edge, so nothing was thrown away to make the picture small.
      const filled = Math.max(out.drawn.width / out.stage.width, out.drawn.height / out.stage.height);
      expect(filled, `fitted, but only filling ${Math.round(filled * 100)}% of the stage's long side`).toBeGreaterThan(0.9);

      // 3. The floor the app derived is the fit, not a number written down.
      const floor = Number(await page.getByTestId('file-preview-image-stage').getAttribute('data-min-scale'));
      expect(floor, 'the floor is still the fixed 25%').toBeLessThan(0.25);
      expect(floor).toBeCloseTo(Math.min(opened.stage.width / BIG.width, opened.stage.height / BIG.height), 3);

      // 4. One press gets there too. A floor of 3% reached only by wheeling is
      //    not a floor a reader on a phone can reach.
      await page.getByTestId('file-preview-zoom-level').click();
      await expect.poll(async () => (await measured(page)).scale).toBeCloseTo(1, 3);
      await page.getByTestId('file-preview-fit').click();
      const fitted = await measured(page);
      expect(fitted.drawn.width).toBeLessThanOrEqual(fitted.stage.width + 1);
      expect(fitted.drawn.height).toBeLessThanOrEqual(fitted.stage.height + 1);
      expect(fitted.scale, 'Fit and the floor disagree').toBeCloseTo(out.scale, 3);
      record(`${screen.dir}-judge`, say(`${screen.name}, one press of Fit`, fitted));
      await page.screenshot({ path: join(SHOTS, `${screen.dir}-fitted.png`), animations: 'disabled' });

      // 5. Fit never enlarges: the app's decision is that a picture is opened at
      //    its own pixels, so a small one is left alone rather than blown up.
      expect(fitted.scale).toBeLessThanOrEqual(1);
    });
  });
}
