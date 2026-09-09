import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type CDPSession, type Locator, type Page } from '@playwright/test';

import { ruledPng } from './fixture-png';

/**
 * A picture is pinched and dragged with fingers, not only wheeled with a mouse
 * (bw-e3dw.4).
 *
 * The survey found it at 390px: two fingers spreading over a picture left the
 * zoom at 100%, because `useZoomPan` tracked exactly one pointer and had no
 * idea what a second one meant. The wheel half was already right and already
 * anchored, so the fix is the same maths reached by another gesture rather
 * than a second gesture with rules of its own — a pinch anchors on the
 * midpoint between the two fingers exactly as the wheel anchors on the
 * pointer.
 *
 * Two things about how this is driven, both of which matter:
 *
 * - `page.touchscreen` cannot do multi-touch, so the fingers are dispatched
 *   through CDP `Input.dispatchTouchEvent`. Those are real touches: the
 *   renderer turns them into real pointer events with real pointer ids, so the
 *   app's own listeners run and `setPointerCapture` works. Synthesised
 *   `PointerEvent`s from `page.evaluate` would have neither.
 * - The claim is not "a number went up". It is that the pinch is ANCHORED:
 *   the point of the picture under the midpoint of the two fingers is still
 *   under it afterwards. That is measured off bounding boxes, the same way the
 *   wheel case measures it.
 *
 * Both surfaces and both file kinds: the Files tab draws a raster picture and
 * an SVG through the same stage since bw-e3dw.15, and the chat has a viewer of
 * its own; all three come through `useZoomPan`, so all three owe the same
 * answer and a pinch that only works on one of them is not done.
 *
 * Run: PINCH_STAGE=before scripts/workbench-e2e.sh tests/e2e/a-picture-is-pinched-on-a-touch-screen.spec.ts
 */

const STAGE = process.env.PINCH_STAGE ?? 'now';
const SHOTS = join(__dirname, '..', 'results', 'pinch', STAGE);
const FIXTURE = join(__dirname, '..', '.workbench-run-pinch');
const WAIT = 60_000;

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
test.setTimeout(600_000);

const measured: string[] = [];
function note(what: string): void {
  measured.push(what);
}

/** Ruled every 40px, so a zoom anchored on the fingers can be seen, not only computed. */
function ruledSvg(width: number, height: number): string {
  const lines: string[] = [];
  for (let x = 0; x <= width; x += 40) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${x % 200 ? '#8ab' : '#f26'}" stroke-width="${x % 200 ? 1 : 3}"/>`);
  }
  for (let y = 0; y <= height; y += 40) {
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${y % 200 ? '#8ab' : '#f26'}" stroke-width="${y % 200 ? 1 : 3}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
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

/** Two fingers on a horizontal line through `at`, `apart` pixels between them. */
function fingers(at: { x: number; y: number }, apart: number) {
  return [
    { x: at.x - apart / 2, y: at.y, id: 1 },
    { x: at.x + apart / 2, y: at.y, id: 2 },
  ];
}

/** A pinch, spread or squeeze, driven as real touches. */
async function pinch(touch: CDPSession, at: { x: number; y: number }, from: number, to: number): Promise<void> {
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(at, from) });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(at, from + ((to - from) * i) / steps) });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** One finger, laid down and dragged. */
async function oneFinger(touch: CDPSession, from: { x: number; y: number }, by: { x: number; y: number }): Promise<void> {
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (by.x * i) / steps, y: from.y + (by.y * i) / steps, id: 1 }],
    });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * The whole claim, asked of one picture on one surface.
 *
 * `at` is chosen well off the centre of the box on purpose: a zoom about the
 * middle is right about the middle by accident, and would pass a test that
 * pinched there.
 */
async function pinchesAndPans(
  page: Page,
  touch: CDPSession,
  what: string,
  stage: Locator,
  picture: Locator,
  shot: string,
): Promise<void> {
  const box = (await stage.boundingBox())!;
  const resting = (await picture.boundingBox())!;
  const startScale = Number(await stage.getAttribute('data-scale'));
  await page.screenshot({ path: join(SHOTS, `${shot}-01-resting.png`), animations: 'disabled' });

  // Off centre, and over the picture: a third of the way across and down.
  const at = {
    x: Math.round(box.x + box.width * 0.32),
    y: Math.round(box.y + box.height * 0.36),
  };
  const across = (at.x - resting.x) / resting.width;
  const down = (at.y - resting.y) / resting.height;

  await pinch(touch, at, 80, 260);
  await page.waitForTimeout(400);

  const zoomed = Number(await stage.getAttribute('data-scale'));
  const after = (await picture.boundingBox())!;
  const drift = { x: after.x + across * after.width - at.x, y: after.y + down * after.height - at.y };
  note(
    `${what}: two fingers spread from 80px to 260px about (${at.x}, ${at.y}) — `
    + `scale ${startScale} -> ${zoomed}, the picture ${Math.round(resting.width)}px -> ${Math.round(after.width)}px wide, `
    + `and the point that was under the midpoint moved ${Math.round(drift.x)}px across, ${Math.round(drift.y)}px down`,
  );
  await page.screenshot({ path: join(SHOTS, `${shot}-02-pinched.png`), animations: 'disabled' });

  expect(zoomed, `${what}: two fingers spreading did not zoom it`).toBeGreaterThan(startScale * 2);
  expect(Math.abs(drift.x), `${what}: the pinch is not anchored on the midpoint of the fingers`).toBeLessThan(4);
  expect(Math.abs(drift.y), `${what}: the pinch is not anchored on the midpoint of the fingers`).toBeLessThan(4);

  // One finger moves it, and moves it exactly as far as the finger went.
  const before = (await picture.boundingBox())!;
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await oneFinger(touch, middle, { x: -90, y: -60 });
  await page.waitForTimeout(300);
  const moved = (await picture.boundingBox())!;
  note(`${what}: one finger dragged 90px left and 60px up moved it ${Math.round(moved.x - before.x)}px across, ${Math.round(moved.y - before.y)}px down`);
  await page.screenshot({ path: join(SHOTS, `${shot}-03-dragged.png`), animations: 'disabled' });
  expect(moved.x, `${what}: one finger did not move the picture`).toBeCloseTo(before.x - 90, 0);
  expect(moved.y, `${what}: one finger did not move the picture`).toBeCloseTo(before.y - 60, 0);

  // And squeezing takes it back down, so the gesture is not one way only. About
  // the middle of the box this time, because 260px of fingers about a point a
  // third of the way across a 390px screen puts one of them past the left edge,
  // where it never lands on the picture at all.
  await pinch(touch, { x: Math.round(box.x + box.width / 2), y: at.y }, 260, 80);
  await page.waitForTimeout(400);
  const squeezed = Number(await stage.getAttribute('data-scale'));
  note(`${what}: two fingers squeezed back from 260px to 80px — scale ${zoomed} -> ${squeezed}`);
  expect(squeezed, `${what}: a squeeze did not zoom out`).toBeLessThan(zoomed);

  // The page itself never moved: `touch-action: none` on the stage is what
  // stops the browser taking the gesture and scrolling instead.
  const carried = await page.evaluate(() => ({
    action: getComputedStyle(document.querySelector('[data-testid="file-preview-image-stage"], [data-testid="picture-zoom-viewport"]')!).touchAction,
    scrolled: window.scrollX,
  }));
  note(`${what}: the stage declares touch-action: ${carried.action}, and the page has scrolled ${carried.scrolled}px sideways`);
  expect(carried.action, `${what}: the browser is free to take the gesture`).toBe('none');
  expect(carried.scrolled, `${what}: the gesture scrolled the page instead`).toBe(0);
}

test('a picture is pinched and dragged with fingers, on every surface that shows one', async ({ page, request }) => {
  await showTestProjects(page);
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  git(FIXTURE, 'init', '-q', '-b', 'main', '.');
  git(FIXTURE, 'config', 'user.name', 'Atelier Tester');
  git(FIXTURE, 'config', 'user.email', 'tester@atelier.test');
  git(FIXTURE, 'config', 'commit.gpgsign', 'false');
  git(FIXTURE, 'commit', '-qm', 'seed', '--allow-empty');
  // Wider than a 390px stage, so there is somewhere to go at 100% and a drag
  // means something before the pinch has even happened.
  const png = join(FIXTURE, 'ruled.png');
  const svg = join(FIXTURE, 'ruled.svg');
  writeFileSync(png, ruledPng(1200, 800));
  writeFileSync(svg, ruledSvg(1200, 800));

  const touch = await page.context().newCDPSession(page);
  const project = await fixtureProject(request, 'pinch', FIXTURE);
  try {
    for (const [kind, file, shot] of [['image', png, 'png'], ['svg', svg, 'svg']] as const) {
      await page.goto(`/project?id=${project.id}&tab=files&file=${encodeURIComponent(file)}`);
      await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', kind, { timeout: WAIT });
      const picture = page.getByTestId('file-preview-image');
      await expect(picture).toBeVisible({ timeout: WAIT });
      await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete), { timeout: WAIT }).toBe(true);
      await page.waitForTimeout(600);
      await pinchesAndPans(page, touch, `the Files tab, a ${kind}`, page.getByTestId('file-preview-image-stage'), picture, shot);
    }
  } finally {
    const report = ['', `======== A PICTURE PINCHED ON A TOUCH SCREEN (${STAGE}) ========`, '', ...measured.map((one) => `   * ${one}`), ''].join('\n');
    console.log(report);
    writeFileSync(join(SHOTS, 'measurements.txt'), report);
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
