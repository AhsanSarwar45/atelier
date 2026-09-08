import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { ruledPng } from './fixture-png';

/**
 * A picture zooms under the wheel and is dragged around, on every surface that
 * shows one (bw-gy6z).
 *
 * The manager had just opened a picture in the Files tab: it had a −/%/+ trio
 * and no way to move a zoomed picture at all, so a picture zoomed in was a
 * picture he could not look around. "It must be zoomable and pannable."
 *
 * The claim this case exists to settle is not "the scale changed" — a unit test
 * can watch a number go up. It is that the zoom is ANCHORED: the pixel under
 * the pointer is still under the pointer afterwards. That is a question about
 * where things were actually drawn, so it is asked of a real browser, of a real
 * picture, twice — once in the Files tab and once in the chat's viewer, because
 * the point of the shared hook is that both answer the same way.
 *
 * The picture is ruled every 40 pixels so the anchoring can be seen and not
 * only computed: in the screenshots the grid crossing under the pointer is the
 * same crossing before and after.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-picture-zooms-under-the-wheel.spec.ts
 */

const SHOTS = join(__dirname, '..', 'results');
const FILES_FIXTURE = join(__dirname, '..', '.workbench-run-wheel-files');
const CHAT_FIXTURE = join(__dirname, '..', '.workbench-run-wheel-chat');
const WAIT = 60_000;

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
test.setTimeout(180_000);

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

/**
 * A crosshair nailed to one point of the GLASS, so the screenshots carry the
 * proof and not merely the numbers.
 *
 * The assertion below is arithmetic on bounding boxes, which is the honest
 * measurement but is unreadable in a picture. With the marker pinned at the
 * anchor, the before and after shots can simply be looked at: the same crossing
 * of the ruled grid sits under it in both, at a different scale. A zoom about
 * the middle of the box would have carried that crossing away.
 */
async function crosshair(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.evaluate(({ x, y }) => {
    document.getElementById('anchor-proof')?.remove();
    const mark = document.createElement('div');
    mark.id = 'anchor-proof';
    mark.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0;z-index:2147483647;pointer-events:none`;
    mark.innerHTML = '<div style="position:absolute;left:-40px;top:-1px;width:80px;height:2px;background:#ff2d55"></div>'
      + '<div style="position:absolute;left:-1px;top:-40px;width:2px;height:80px;background:#ff2d55"></div>'
      + '<div style="position:absolute;left:-7px;top:-7px;width:14px;height:14px;border:2px solid #ff2d55;border-radius:50%"></div>';
    document.body.appendChild(mark);
  }, at);
}

async function unmark(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('anchor-proof')?.remove());
}

/**
 * The proof itself, in one function because both surfaces owe the same answer.
 *
 * A point of the PICTURE is named as a fraction of the drawn box — that is what
 * survives a change of scale — and the assertion is that after the wheel has
 * turned, that same fraction is drawn at the same place on the glass as the
 * pointer that anchored it. Anything zooming about the middle of the box misses
 * by tens of pixels here; the tolerance is a couple, for rounding and for the
 * half-pixel a browser lands transforms on.
 */
async function wheelAnchoredAt(page: Page, picture: Locator, at: { x: number; y: number }, notches: number) {
  const before = (await picture.boundingBox())!;
  const across = (at.x - before.x) / before.width;
  const down = (at.y - before.y) / before.height;
  expect(across, 'the anchor is not over the picture').toBeGreaterThan(0.05);
  expect(down, 'the anchor is not over the picture').toBeGreaterThan(0.05);

  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, notches);
  await expect.poll(async () => (await picture.boundingBox())!.width).not.toBe(before.width);

  const after = (await picture.boundingBox())!;
  expect(after.width, 'the wheel did not zoom').toBeGreaterThan(before.width);
  const drawnX = after.x + across * after.width;
  const drawnY = after.y + down * after.height;
  expect(
    Math.abs(drawnX - at.x),
    `the point under the pointer moved ${Math.round(drawnX - at.x)}px across: the zoom is not anchored`,
  ).toBeLessThan(2.5);
  expect(
    Math.abs(drawnY - at.y),
    `the point under the pointer moved ${Math.round(drawnY - at.y)}px down: the zoom is not anchored`,
  ).toBeLessThan(2.5);
  return { before, after };
}

test('a picture in the Files tab zooms about the pointer, drags, and is put back', async ({ page, request }) => {
  await showTestProjects(page);
  rmSync(FILES_FIXTURE, { recursive: true, force: true });
  mkdirSync(FILES_FIXTURE, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  git(FILES_FIXTURE, 'init', '-q', '-b', 'main', '.');
  git(FILES_FIXTURE, 'config', 'user.name', 'Atelier Tester');
  git(FILES_FIXTURE, 'config', 'user.email', 'tester@atelier.test');
  git(FILES_FIXTURE, 'config', 'commit.gpgsign', 'false');
  git(FILES_FIXTURE, 'commit', '-qm', 'seed', '--allow-empty');
  // Bigger than the room it is shown in, which is the only case where panning
  // means anything.
  const ruled = join(FILES_FIXTURE, 'ruled.png');
  writeFileSync(ruled, ruledPng(2400, 1600));

  const project = await fixtureProject(request, 'wheel-files', FILES_FIXTURE);
  try {
    await page.goto(`/project?id=${project.id}&tab=files&file=${encodeURIComponent(ruled)}`);
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'image', { timeout: WAIT });
    await expect(page.getByTestId('file-preview-dimensions')).toHaveText('2400 × 1600', { timeout: WAIT });

    const stage = page.getByTestId('file-preview-image-stage');
    const picture = page.getByTestId('file-preview-image');
    const box = (await stage.boundingBox())!;
    // A picture larger than its box has somewhere to go, and says so.
    await expect(stage).toHaveAttribute('data-pannable', 'true');

    // The anchor is a named pixel of the picture — the crossing of two heavy
    // rules at (1000, 600) — rather than a place on the screen, so the marker
    // lands on a landmark and the two shots can be compared by eye. Well off
    // centre, too: a zoom about the middle of the box is right about the middle
    // by accident.
    const drawn = (await picture.boundingBox())!;
    const at = { x: drawn.x + (1000 / 2400) * drawn.width, y: drawn.y + (600 / 1600) * drawn.height };
    await crosshair(page, at);
    await page.screenshot({ path: join(SHOTS, 'bw-gy6z-files-resting.png'), animations: 'disabled' });

    // 1. The wheel zooms, about the pointer.
    await wheelAnchoredAt(page, picture, at, -400);
    const zoomed = Number(await stage.getAttribute('data-scale'));
    expect(zoomed, 'the wheel did not zoom in').toBeGreaterThan(1.2);
    await expect(page.getByTestId('file-preview-zoom-level')).toHaveText(`${Math.round(zoomed * 100)}%`);
    await page.screenshot({ path: join(SHOTS, 'bw-gy6z-files-wheel-zoomed.png'), animations: 'disabled' });
    await unmark(page);

    // 2. A trackpad pinch is a wheel event with ctrl held, and zooms harder.
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -20);
    await page.keyboard.up('Control');
    await expect.poll(async () => Number(await stage.getAttribute('data-scale'))).toBeGreaterThan(zoomed);

    // 3. The hand moves it, and it says it is being moved while it happens.
    const panBefore = Number(await stage.getAttribute('data-pan-x'));
    const spot = (await picture.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 160, box.y + box.height / 2 - 90, { steps: 8 });
    await expect(stage).toHaveAttribute('data-dragging', 'true');
    await page.screenshot({ path: join(SHOTS, 'bw-gy6z-files-panned.png'), animations: 'disabled' });
    await page.mouse.up();
    await expect(stage).not.toHaveAttribute('data-dragging', 'true');
    expect(Number(await stage.getAttribute('data-pan-x')), 'the drag did not move the picture').toBeCloseTo(panBefore - 160, 0);
    const moved = (await picture.boundingBox())!;
    expect(moved.x, 'the picture did not actually move on the glass').toBeCloseTo(spot.x - 160, 0);

    // 4. It cannot be thrown off the screen: dragged far past its own edge it
    //    stops with the edge at the edge of the box, not somewhere out of sight.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 4, box.y + box.height * 4, { steps: 6 });
    await page.mouse.up();
    const shoved = (await picture.boundingBox())!;
    expect(shoved.x, 'the picture was dragged clean off the box').toBeLessThanOrEqual(box.x + 1);
    expect(shoved.x + shoved.width, 'the picture was dragged clean off the box').toBeGreaterThanOrEqual(box.x + box.width - 1);

    // 5. The percentage is still the button that puts it back — scale AND
    //    position, because a reset that leaves it in a corner reset nothing.
    await page.getByTestId('file-preview-zoom-level').click();
    await expect(page.getByTestId('file-preview-zoom-level')).toHaveText('100%');
    await expect(stage).toHaveAttribute('data-pan-x', '0');
    await expect(stage).toHaveAttribute('data-pan-y', '0');

    // 6. And the old buttons still work.
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.getByTestId('file-preview-zoom-level')).toHaveText('150%');
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(page.getByTestId('file-preview-zoom-level')).toHaveText('100%');
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FILES_FIXTURE, { recursive: true, force: true });
  }
});

/** Where the tool keeps its records, worked out the way the app works it out. */
function recordDir(projectPath: string): string {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(config, 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** A chat with one big ruled picture pasted into it, written down as the tool writes it. */
function aChatWithARuledPicture(projectPath: string) {
  const id = randomUUID();
  const dir = recordDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const line = (parent: string | null, type: 'user' | 'assistant', content: unknown) => {
    const uuid = randomUUID();
    return {
      uuid,
      text: JSON.stringify({
        parentUuid: parent, isSidechain: false, type,
        message: { role: type, content },
        uuid, timestamp: new Date().toISOString(), userType: 'external', entrypoint: 'cli',
        cwd: projectPath, sessionId: id, version: '2.1.232',
      }),
    };
  };
  const asked = line(null, 'user', [
    { type: 'text', text: 'look closely at this grid [Image #1]' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ruledPng(1600, 1200).toString('base64') } },
  ]);
  const answered = line(asked.uuid, 'assistant', [{ type: 'text', text: 'A ruled grid, forty pixels to a square.' }]);
  writeFileSync(file, `${asked.text}\n${answered.text}\n`);
  return { id, forget: () => rmSync(file, { force: true }) };
}

test('a picture opened from a chat zooms about the pointer and drags too', async ({ page, request }) => {
  await showTestProjects(page);
  rmSync(CHAT_FIXTURE, { recursive: true, force: true });
  mkdirSync(CHAT_FIXTURE, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });

  const project = await fixtureProject(request, 'wheel-chat', CHAT_FIXTURE);
  const chat = aChatWithARuledPicture(CHAT_FIXTURE);
  let sessionId = '';
  try {
    const opened = await request.post('/api/workbench/command', {
      data: { type: 'session.open', externalId: chat.id, brand: 'claude', projectId: project.id, projectPath: CHAT_FIXTURE },
    });
    expect(opened.status(), await opened.text()).toBe(200);
    sessionId = ((await opened.json()) as { id: string }).id;

    await page.goto(`/project?id=${project.id}&chat=${sessionId}`);
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: WAIT });
    const thumbnail = page.getByTestId('user-message').getByTestId('message-image').first();
    await expect(thumbnail).toBeVisible({ timeout: WAIT });

    // The thumbnail in the transcript is a thumbnail: it opens the viewer,
    // which is where the gesture lives, so the chat still scrolls past it.
    await thumbnail.click();
    await expect(page.getByTestId('picture-viewer')).toBeVisible();
    const viewport = page.getByTestId('picture-zoom-viewport');
    const layer = page.getByTestId('picture-transform');
    const picture = page.getByTestId('picture-viewer-image');
    const box = (await viewport.boundingBox())!;

    const drawn = (await picture.boundingBox())!;
    const at = { x: drawn.x + 0.35 * drawn.width, y: drawn.y + 0.35 * drawn.height };
    await crosshair(page, at);
    await page.screenshot({ path: join(SHOTS, 'bw-gy6z-viewer-resting.png'), animations: 'disabled' });
    await wheelAnchoredAt(page, picture, at, -400);
    const zoomed = Number(await layer.getAttribute('data-scale'));
    expect(zoomed).toBeGreaterThan(1.2);
    await expect(page.getByTestId('picture-zoom-level')).toHaveText(`${Math.round(zoomed * 100)}%`);
    await page.screenshot({ path: join(SHOTS, 'bw-gy6z-viewer-wheel-zoomed.png'), animations: 'disabled' });
    await unmark(page);

    // Dragged, and then put back by the control that says so.
    const spot = (await picture.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 + 70, { steps: 8 });
    await page.mouse.up();
    expect((await picture.boundingBox())!.x).toBeCloseTo(spot.x - 120, 0);
    await page.screenshot({ path: join(SHOTS, 'bw-gy6z-viewer-panned.png'), animations: 'disabled' });

    await page.getByRole('button', { name: 'Reset zoom and position' }).click();
    await expect(layer).toHaveAttribute('data-scale', '1');
    await expect(layer).toHaveAttribute('data-pan-x', '0');
    await expect(layer).toHaveAttribute('data-pan-y', '0');

    // The buttons that were there before still are.
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.getByTestId('picture-zoom-level')).toHaveText('150%');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('picture-viewer')).toHaveCount(0);
  } finally {
    if (sessionId) await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId } });
    chat.forget();
    await request.delete(`/api/projects/${project.id}`);
    rmSync(CHAT_FIXTURE, { recursive: true, force: true });
  }
});
