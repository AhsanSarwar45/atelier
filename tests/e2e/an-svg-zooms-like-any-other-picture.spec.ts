import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * An SVG is a picture, and zooms and pans like one (bw-e3dw.15).
 *
 * The owner met this in the running app — "svg doesnt seem zoombable" — and it
 * was worse than a touch gap: `file-preview.tsx` drew the `image` kind through
 * `ImagePreview`, which holds `useZoomPan`, and drew the `svg` kind a few lines
 * below as a second hand-rolled stage, a plain `<img className="max-h-full
 * max-w-full">` in an `overflow-auto` box. No transform, no handlers — an SVG
 * could not be zoomed by ANY pointer, wheel or trackpad or hand.
 *
 * Both stages carried the same `data-testid="file-preview-image-stage"`, which
 * is exactly why the zoom specs never caught it: they open a PNG, and got the
 * working stage. So this case opens an SVG on purpose and asks the stage for
 * the numbers only a live gesture can produce.
 *
 * Two SVGs, because they differ in the one way that matters to a viewer that
 * draws a picture at its own pixel size: `sized.svg` declares how big it is,
 * `unsized.svg` carries only a `viewBox`. The second is the one worth asking
 * about, because a viewer that reads its size off `naturalWidth` would show
 * nothing at all if the answer came back zero. It does not — a browser falls
 * back to the default object size of 300 x 150 fitted to the viewBox — and
 * this case is what says so, rather than a guess in the source.
 *
 * Run: SVG_ZOOM_STAGE=before scripts/workbench-e2e.sh tests/e2e/an-svg-zooms-like-any-other-picture.spec.ts
 */

const STAGE = process.env.SVG_ZOOM_STAGE ?? 'now';
const SHOTS = join(__dirname, '..', 'results', 'svg-zoom', STAGE);
const FIXTURE = join(__dirname, '..', '.workbench-run-svg-zoom');
const WAIT = 60_000;

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
test.setTimeout(300_000);

const measured: string[] = [];
function note(what: string): void {
  measured.push(what);
}

/** Ruled every 40px, so an anchored zoom can be seen and not only computed. */
function ruledSvg(width: number, height: number, sized: boolean): string {
  const lines: string[] = [];
  for (let x = 0; x <= width; x += 40) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${x % 200 ? '#8ab' : '#f26'}" stroke-width="${x % 200 ? 1 : 3}"/>`);
  }
  for (let y = 0; y <= height; y += 40) {
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${y % 200 ? '#8ab' : '#f26'}" stroke-width="${y % 200 ? 1 : 3}"/>`);
  }
  const size = sized ? ` width="${width}" height="${height}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg"${size} viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="#132"/>${lines.join('')}</svg>\n`;
}

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

async function showTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

/** What the stage says about itself, or nothing at all when it is a dead div. */
async function stageState(stage: Locator) {
  return {
    scale: await stage.getAttribute('data-scale'),
    panX: await stage.getAttribute('data-pan-x'),
    pannable: await stage.getAttribute('data-pannable'),
  };
}

test('an svg zooms under the wheel and pans under the hand, like every other picture', async ({ page, request }) => {
  await showTestProjects(page);
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  git(FIXTURE, 'init', '-q', '-b', 'main', '.');
  git(FIXTURE, 'config', 'user.name', 'Atelier Tester');
  git(FIXTURE, 'config', 'user.email', 'tester@atelier.test');
  git(FIXTURE, 'config', 'commit.gpgsign', 'false');
  git(FIXTURE, 'commit', '-qm', 'seed', '--allow-empty');
  // Bigger than the room it is shown in, which is the only case where panning
  // means anything.
  const sized = join(FIXTURE, 'sized.svg');
  const unsized = join(FIXTURE, 'unsized.svg');
  writeFileSync(sized, ruledSvg(2400, 1600, true));
  writeFileSync(unsized, ruledSvg(2400, 1600, false));

  const project = await fixtureProject(request, 'svg-zoom', FIXTURE);
  try {
    await page.goto(`/project?id=${project.id}&tab=files&file=${encodeURIComponent(sized)}`);
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'svg', { timeout: WAIT });

    const stage = page.getByTestId('file-preview-image-stage');
    const picture = page.getByTestId('file-preview-image');
    await expect(picture).toBeVisible({ timeout: WAIT });
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete), { timeout: WAIT })
      .toBe(true);
    await page.waitForTimeout(400);

    const resting = await stageState(stage);
    const drawnAtRest = (await picture.boundingBox())!;
    note(
      `the svg stage at rest: data-scale=${resting.scale ?? 'ABSENT'}, `
      + `data-pan-x=${resting.panX ?? 'ABSENT'}, data-pannable=${resting.pannable ?? 'ABSENT'}; `
      + `the picture is drawn ${Math.round(drawnAtRest.width)}x${Math.round(drawnAtRest.height)}`,
    );
    await page.screenshot({ path: join(SHOTS, '01-svg-resting.png'), animations: 'disabled' });

    // 1. The wheel, anchored: the pixel under the pointer stays under it.
    //    Measured before anything is asserted, so a run against the broken
    //    build records what the wheel did rather than stopping short of it.
    const at = { x: drawnAtRest.x + 0.3 * drawnAtRest.width, y: drawnAtRest.y + 0.3 * drawnAtRest.height };
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(300);
    const zoomed = Number(await stage.getAttribute('data-scale'));
    const after = (await picture.boundingBox())!;
    const drift = {
      x: after.x + 0.3 * after.width - at.x,
      y: after.y + 0.3 * after.height - at.y,
    };
    note(
      `after four wheel notches over the picture: scale ${resting.scale ?? '(none)'} -> ${zoomed || 'unchanged'}, `
      + `the picture is drawn ${Math.round(after.width)}x${Math.round(after.height)}, `
      + `and the point that was under the pointer moved ${Math.round(drift.x)}px across, ${Math.round(drift.y)}px down`,
    );
    await page.screenshot({ path: join(SHOTS, '02-svg-wheel-zoomed.png'), animations: 'disabled' });

    // A dead stage has none of these, which is the whole difference between
    // the two stages that used to share this name.
    expect(resting.scale, 'the svg stage reports no scale: it is not a zooming stage at all').not.toBeNull();
    expect(resting.pannable, 'an svg larger than its box says it cannot be moved').toBe('true');
    expect(zoomed, 'the wheel did not zoom the svg').toBeGreaterThan(1.2);
    expect(Math.abs(drift.x), 'the zoom is not anchored on the pointer').toBeLessThan(2.5);
    expect(Math.abs(drift.y), 'the zoom is not anchored on the pointer').toBeLessThan(2.5);
    await expect(page.getByTestId('file-preview-zoom-level')).toHaveText(`${Math.round(zoomed * 100)}%`);

    // 2. The hand moves it.
    const box = (await stage.boundingBox())!;
    const before = (await picture.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2 - 80, { steps: 8 });
    await expect(stage).toHaveAttribute('data-dragging', 'true');
    await page.mouse.up();
    const moved = (await picture.boundingBox())!;
    note(`one drag of 150px left: the svg moved ${Math.round(moved.x - before.x)}px on the glass, data-pan-x=${await stage.getAttribute('data-pan-x')}`);
    await page.screenshot({ path: join(SHOTS, '03-svg-panned.png'), animations: 'disabled' });
    expect(moved.x, 'the drag did not move the svg').toBeCloseTo(before.x - 150, 0);

    // 3. The percentage still puts it back, and the buttons still step.
    await page.getByTestId('file-preview-zoom-level').click();
    await expect(page.getByTestId('file-preview-zoom-level')).toHaveText('100%');
    await expect(stage).toHaveAttribute('data-pan-x', '0');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.getByTestId('file-preview-zoom-level')).toHaveText('150%');
    await page.getByTestId('file-preview-zoom-level').click();

    // 4. An SVG is still legibly source as well: the switch it always had is
    //    still there, sharing the picture's own bar rather than a second one.
    const bars = await page.getByTestId('file-preview-bar').count();
    note(`the svg preview draws ${bars} bar(s), carrying both the zoom and the Source/Preview switch`);
    expect(bars, 'the switch and the zoom are on two stacked bars').toBe(1);
    await page.getByTestId('file-preview-source').click();
    await expect(page.getByTestId('file-preview-source-view')).toBeVisible({ timeout: WAIT });
    await page.getByTestId('file-preview-preview').click();
    await expect(page.getByTestId('file-preview-image-stage')).toBeVisible({ timeout: WAIT });

    // 5. An SVG that declares no size of its own still has one, and still
    //    zooms — this is where the `naturalWidth` the stage sizes itself by is
    //    proved to be a real number rather than a zero.
    await page.goto(`/project?id=${project.id}&tab=files&file=${encodeURIComponent(unsized)}`);
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'svg', { timeout: WAIT });
    await expect(page.getByTestId('file-preview-image')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(600);
    const dimensions = await page.getByTestId('file-preview-dimensions').textContent();
    const shown = (await page.getByTestId('file-preview-image').boundingBox())!;
    note(`a viewBox-only svg reports "${dimensions?.trim()}" and is drawn ${Math.round(shown.width)}x${Math.round(shown.height)}`);
    await page.screenshot({ path: join(SHOTS, '04-svg-without-a-size.png'), animations: 'disabled' });
    expect(shown.width, 'an svg with no intrinsic size was drawn as nothing').toBeGreaterThan(1);
    await page.mouse.move(shown.x + shown.width / 2, shown.y + shown.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(300);
    const unsizedZoom = Number(await page.getByTestId('file-preview-image-stage').getAttribute('data-scale'));
    note(`the same svg under four wheel notches: scale ${unsizedZoom}`);
    expect(unsizedZoom, 'an svg with no intrinsic size does not zoom').toBeGreaterThan(1.2);
  } finally {
    const report = ['', `======== AN SVG ZOOMS LIKE ANY OTHER PICTURE (${STAGE}) ========`, '', ...measured.map((one) => `   * ${one}`), ''].join('\n');
    console.log(report);
    writeFileSync(join(SHOTS, 'measurements.txt'), report);
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
