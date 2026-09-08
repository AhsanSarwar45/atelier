import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A picture, a video, an SVG and a Markdown file, each opened in the Files tab
 * and each drawn as the thing it is (bw-g3o3.14).
 *
 * Every one of these is a claim only a browser can settle. A picture "centred
 * on a checkerboard at its own pixel size" is a layout; a video that can be
 * seeked is the server's Range answer (bw-g3o3.2) and the browser's decoder
 * agreeing, which no mock reproduces; an SVG drawn as a picture and its own
 * source are two views of one file that a unit test can only tell apart by
 * name. So the fixture is a real folder of real files, the app reads them off
 * the disk through its own routes, and each view is photographed.
 *
 * The strip is exercised on the way through: the files are opened by address,
 * one at a time, and pinned as they go — which is what a reader does when they
 * mean to keep something — so the last screenshot is a strip with four tabs,
 * three kept and one still in the replaceable slot.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-file-opens-as-what-it-is.spec.ts
 */

const SHOTS = 'tests/results';
const FIXTURE = join(__dirname, '..', '.workbench-run-file-previews');
const MEDIA = join(__dirname, '..', 'fixtures', 'files-preview');
const WAIT = 60_000;

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
// Four kinds, a video decode and two CodeMirror mounts in one pass.
test.setTimeout(180_000);

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140" viewBox="0 0 200 140">
  <rect x="10" y="10" width="180" height="120" rx="12" fill="#519aba" />
  <circle cx="100" cy="70" r="38" fill="#e37933" />
</svg>
`;

const MARKDOWN = `# Reading a file in place

The Files tab opens whatever it is handed **as the thing it is**.

- a picture on a checkerboard, at its own pixel size
- a video you can actually seek
- this file, either as prose or as its own source

> A file manager is one window too many.
`;

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/** Open a file the way a link into it does, and wait for the tab to settle. */
async function openByAddress(page: Page, project: string, file: string): Promise<void> {
  await page.goto(`/project?id=${project}&tab=files&file=${encodeURIComponent(file)}`);
  await page.getByTestId('files-tab').waitFor({ timeout: WAIT });
  await expect.poll(() => page.getByTestId('files-viewer').getAttribute('data-file'), { timeout: WAIT }).toBe(file);
}

/** Keep it: what a double click on its tab means. */
async function pin(page: Page, file: string): Promise<void> {
  const tab = page.locator(`[data-testid=open-file][data-path="${file}"]`);
  await tab.dblclick();
  await expect(tab).not.toHaveAttribute('data-preview', 'true');
}

test('a picture, a video, an SVG and a Markdown file each open as what they are', async ({ page, request }) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'assets'), { recursive: true });
  git(FIXTURE, 'init', '-q', '-b', 'main', '.');
  git(FIXTURE, 'config', 'user.name', 'Atelier Tester');
  git(FIXTURE, 'config', 'user.email', 'tester@atelier.test');
  git(FIXTURE, 'config', 'commit.gpgsign', 'false');
  git(FIXTURE, 'commit', '-qm', 'seed', '--allow-empty');

  const png = join(FIXTURE, 'assets', 'shot.png');
  const mp4 = join(FIXTURE, 'assets', 'clip.mp4');
  const svg = join(FIXTURE, 'assets', 'logo.svg');
  const md = join(FIXTURE, 'NOTES.md');
  copyFileSync(join(MEDIA, 'shot.png'), png);
  copyFileSync(join(MEDIA, 'clip.mp4'), mp4);
  writeFileSync(svg, SVG);
  writeFileSync(md, MARKDOWN);

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const project = await fixtureProject(request, 'file-previews', FIXTURE);

  // Every answer the media route gave, so the video's seek can be shown to
  // have been served as a partial rather than as the whole file again.
  const media: { url: string; status: number }[] = [];
  page.on('response', (answer) => {
    if (answer.url().includes('/api/fs/media')) media.push({ url: answer.url(), status: answer.status() });
  });

  try {
    mkdirSync(SHOTS, { recursive: true });

    // ── A picture ────────────────────────────────────────────────────────
    await openByAddress(page, project.id, png);
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'image', { timeout: WAIT });
    await expect(page.getByTestId('file-preview-dimensions')).toHaveText('160 × 120', { timeout: WAIT });
    const own = (await page.getByTestId('file-preview-image').boundingBox())!;
    expect(own.width, 'the picture is not drawn at its own pixel width').toBeCloseTo(160, 0);

    // Centred on the checkerboard: equal air on both sides of the stage, and
    // the same again above and below. The second half of that is what catches
    // a stage taller than the window, which centres the picture off the
    // bottom of it — on screen and centred are not the same claim.
    const stage = (await page.getByTestId('file-preview-image-stage').boundingBox())!;
    expect(own.x - stage.x).toBeCloseTo(stage.x + stage.width - (own.x + own.width), 0);
    expect(own.y - stage.y).toBeCloseTo(stage.y + stage.height - (own.y + own.height), 0);
    const window = page.viewportSize()!;
    expect(own.y + own.height, 'the picture is centred below the fold').toBeLessThan(window.height);

    await page.screenshot({ path: `${SHOTS}/bw-g3o314-image.png`, animations: 'disabled' });

    // The zoom is a control and not a label.
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.getByTestId('file-preview-zoom-level')).toHaveText('150%');
    await expect.poll(async () => (await page.getByTestId('file-preview-image').boundingBox())!.width).toBeCloseTo(240, 0);
    await page.screenshot({ path: `${SHOTS}/bw-g3o314-image-zoomed.png`, animations: 'disabled' });
    await page.getByTestId('file-preview-zoom-level').click();
    await expect(page.getByTestId('file-preview-zoom-level')).toHaveText('100%');

    await pin(page, png);

    // ── A video, which is only useful if it can be seeked ────────────────
    await openByAddress(page, project.id, mp4);
    const video = page.getByTestId('file-preview-video');
    await expect(video).toBeVisible({ timeout: WAIT });
    // Metadata first: without it there is nothing to seek within.
    const length = await video.evaluate((element: HTMLVideoElement) => new Promise<number>((settle) => {
      if (element.readyState >= 1) return settle(element.duration);
      element.addEventListener('loadedmetadata', () => settle(element.duration), { once: true });
    }));
    expect(length, 'the browser never read the video header').toBeGreaterThan(3);

    const landed = await video.evaluate((element: HTMLVideoElement) => new Promise<number>((settle) => {
      element.addEventListener('seeked', () => settle(element.currentTime), { once: true });
      element.currentTime = element.duration - 1;
    }));
    expect(landed, 'the video did not seek').toBeGreaterThan(3);

    // Seeking works because the browser is allowed to ask for a piece and is
    // given one. Chromium's very first request for a media source is already a
    // range request, so the partial answer is there in what the page fetched —
    // and asked for straight, a middle slice comes back as exactly that slice
    // and not as the file all over again.
    expect(media.some((answer) => answer.status === 206), `media answers: ${JSON.stringify(media)}`).toBe(true);
    const slice = await request.get(`/api/fs/media?path=${encodeURIComponent(mp4)}`, {
      headers: { Range: 'bytes=1024-2047' },
    });
    expect(slice.status()).toBe(206);
    expect(slice.headers()['content-range']).toMatch(/^bytes 1024-2047\/\d+$/);
    expect((await slice.body()).length).toBe(1024);
    await page.screenshot({ path: `${SHOTS}/bw-g3o314-video.png`, animations: 'disabled' });

    await pin(page, mp4);

    // ── An SVG, both ways ────────────────────────────────────────────────
    await openByAddress(page, project.id, svg);
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'svg', { timeout: WAIT });
    const drawn = page.getByTestId('file-preview-image');
    await expect.poll(
      () => drawn.evaluate((element: HTMLImageElement) => element.naturalWidth),
      { timeout: WAIT },
    ).toBe(200);
    await page.screenshot({ path: `${SHOTS}/bw-g3o314-svg.png`, animations: 'disabled' });

    await page.getByTestId('file-preview-source').click();
    await expect(page.locator('.cm-content')).toContainText('<svg', { timeout: WAIT });
    await page.screenshot({ path: `${SHOTS}/bw-g3o314-svg-source.png`, animations: 'disabled' });
    await page.getByTestId('file-preview-preview').click();
    await expect(drawn).toBeVisible();

    await pin(page, svg);

    // ── Markdown, through the app's own prose ────────────────────────────
    await openByAddress(page, project.id, md);
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'markdown', { timeout: WAIT });
    const prose = page.getByTestId('file-preview-markdown');
    await expect(prose.locator('h1')).toHaveText('Reading a file in place', { timeout: WAIT });
    await expect(prose.locator('li')).toHaveCount(3);
    // Drawn as prose, not printed as its own characters.
    await expect(prose).not.toContainText('**');

    // Four files open: three kept, and this one still in the slot a click
    // would take away.
    const tabs = page.getByTestId('open-file');
    await expect(tabs).toHaveCount(4);
    await expect(tabs.nth(3)).toHaveAttribute('data-preview', 'true');
    await expect(tabs.nth(3)).toHaveAttribute('data-current', 'true');
    await page.screenshot({ path: `${SHOTS}/bw-g3o314-markdown.png`, animations: 'disabled' });

    await page.getByTestId('file-preview-source').click();
    await expect(page.locator('.cm-content')).toContainText('# Reading a file in place', { timeout: WAIT });
    await page.screenshot({ path: `${SHOTS}/bw-g3o314-markdown-source.png`, animations: 'disabled' });

    // ── The strip itself ─────────────────────────────────────────────────
    // A tab is a way back to a file, without going near the address bar.
    await page.locator(`[data-testid=open-file][data-path="${png}"]`).click();
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'image', { timeout: WAIT });
    await expect(page.getByTestId('files-viewer')).toHaveAttribute('data-file', png);

    // And the × takes one away, leaving the reader on a neighbour rather than
    // on nothing.
    const closing = page.locator(`[data-testid=open-file][data-path="${md}"]`);
    await closing.hover();
    await closing.getByTestId('open-file-close').click();
    await expect(tabs).toHaveCount(3);
    await expect(page.getByTestId('files-viewer')).toHaveAttribute('data-file', png);
    await page.screenshot({ path: `${SHOTS}/bw-g3o314-strip.png`, animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
