import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';

import { widgetSpecs, type ChatWidget } from '../../src/workbench/chat-widgets';
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * A wipe comparison holds up on the pictures agents actually make of this app.
 *
 * The manager's own proof on 2026-09-03 was a chip row a few dozen pixels tall:
 * the before and after labels, laid over the picture as chips, were wider than
 * it was and hid it entirely, and the zoom button pinned to the picture's top
 * corner ran off its bottom edge and was cut in half (bw-7v5c). Expanded, the
 * line between the two pictures could not be dragged at all — the split was
 * moved by a bare range input that drew as an unexplained grey circle between
 * two squeezed labels (bw-kcri.1) — and whichever single colour the line was
 * given, it vanished into half the pictures it could be drawn over (bw-kcri.2).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/image-compare-short.spec.ts
 */

const BEFORE_ALT = 'Every chip on the line at its own distance from the next, so the limit pair reads as the only two that are joined';
const AFTER_ALT = 'One distance between every pair of chips on the line, so the whole row reads as one run and nothing on it looks joined';
const PALE_ALT = 'A page half white and half black before the change';
const DARK_ALT = 'A page half white and half black after the change';

// Both cases register a fixture project at this worktree's path, and the store
// keeps that path unique, so they cannot be in flight at the same time. The
// file's default is the suite's `fullyParallel`, which put them there.
test.describe.configure({ mode: 'serial' });

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** A chip row the shape of the manager's proof: wide, and a few dozen pixels tall. */
async function chipRow(browser: Browser, path: string, gap: number): Promise<string> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 64 }, colorScheme: 'dark' });
  const chips = ['bw-r8iy.3', 'area:interface', 'kind:bug', 'step:work', 'P2', 'limit 4px', 'limit 8px'].map((label) =>
    `<span style="display:inline-block;padding:4px 10px;border:1px solid #444;border-radius:999px;background:#1e1e22;color:#ddd;font:13px system-ui">${label}</span>`).join('');
  await page.setContent(`<body style="margin:0;background:#111;padding:16px 24px;white-space:nowrap"><div style="display:flex;gap:${gap}px">${chips}</div></body>`);
  await page.screenshot({ path });
  await page.close();
  return path;
}

/** A picture white across its top half and black across its bottom, so one line crosses both. */
async function bands(browser: Browser, path: string, mark: string): Promise<string> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 240 } });
  await page.setContent(`<body style="margin:0"><div style="height:118px;background:#fff"></div><div style="height:4px;background:${mark}"></div><div style="height:118px;background:#000"></div></body>`);
  await page.screenshot({ path });
  await page.close();
  return path;
}

/** The comparison the sidecar itself produces from two files on disk. */
function comparisonOf(before: string, after: string, beforeAlt: string, afterAlt: string): ChatWidget {
  const command = join(process.cwd(), 'server/target/debug/atelier');
  return widgetSpecs(execFileSync(command, ['tool', 'present', 'compare',
    '--before', before, '--after', after, '--before-alt', beforeAlt, '--after-alt', afterAlt, '--mode', 'wipe'], { encoding: 'utf8' }))[0]!;
}

/**
 * One chat holding one widget, opened.
 *
 * A real chat cannot be told to hold a picture on cue, so the record is written
 * in the shape the kit reads back and served over a stubbed socket, under a
 * fixture project of this run's own — the same ground the other chat cases
 * stand on.
 */
async function chatShowing(page: Page, request: APIRequestContext, widget: ChatWidget, chat: string, title: string): Promise<{ id: string }> {
  const common = { sessionId: chat, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...common, seq: 1, type: 'session.started', brand: 'codex', externalId: chat, model: 'gpt-5', cwd: process.cwd(), permissionMode: 'on-request' },
    { ...common, seq: 2, type: 'message.started', messageId: `${chat}-0`, role: 'assistant' },
    { ...common, seq: 3, type: 'text.delta', messageId: `${chat}-0`, text: `\`\`\`atelier-widget\n${JSON.stringify(widget)}\n\`\`\`` },
    { ...common, seq: 4, type: 'widget', messageId: `${chat}-0`, widget },
    { ...common, seq: 5, type: 'message.completed', messageId: `${chat}-0` },
    { ...common, seq: 6, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const snapshot = foldAll(events);

  await page.addInitScript(({ chat: scope, view }) => {
    class Socket {
      static OPEN = 1; readyState = 1;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) { if (new URL(url).searchParams.get('chat') === scope) setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ tag: 'chat.snapshot', scope, data: JSON.stringify(view) }) })), 0); }
      close() { this.readyState = 3; } send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: Socket, configurable: true });
  }, { chat, view: snapshot });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => { if (route.request().method() !== 'GET') return route.continue(); const url = new URL(route.request().url()); url.searchParams.set('include_test', 'true'); await route.continue({ url: url.toString() }); });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: chat, externalId: chat, brand: 'codex', title, state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${chat}$`), (route) => route.fulfill({ json: { sessionId: chat, origin: 'terminal', brand: 'codex', externalId: chat, runningElsewhere: false, held: null, title, cwd: process.cwd(), beads: [] } }));

  const made = await request.post('/api/projects', { data: { name: title, path: process.cwd(), isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = await made.json() as { id: string };
  await page.goto(`/project?id=${project.id}&tab=chat`);
  await page.getByTestId('restore-row').filter({ hasText: title }).getByTestId('row-name').click();
  return project;
}

/**
 * Reading pixels means waiting for pixels: a picture the browser has been given
 * but has not decoded yet is an empty box, and every row of it scans as neither
 * white nor black.
 */
async function painted(image: Locator) {
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty('complete', true);
  expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth), 'the picture never decoded').toBeGreaterThan(0);
}

/** One row of a decoded patch, as the luminances of its pixels left to right. */
function rows(png: PNG): number[][] {
  const all: number[][] = [];
  for (let y = 0; y < png.height; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < png.width; x += 1) {
      const at = (y * png.width + x) * 4;
      row.push(0.299 * png.data[at]! + 0.587 * png.data[at + 1]! + 0.114 * png.data[at + 2]!);
    }
    all.push(row);
  }
  return all;
}

/**
 * The line has to be findable over both halves of the picture behind it: a dark
 * pixel where the picture is white, a light one where the picture is black.
 * Either one alone is a line that disappears on half the pictures agents take.
 *
 * Where those halves land on the screen is not worth calculating — the picture
 * is centred inside its box by `object-contain`, at whatever scale fits — so
 * this reads the picture's own pixels and finds them. The read is an element
 * screenshot, which is the picture's box with whatever is drawn over it, and
 * therefore in the same coordinates the boxes are measured in. A row counts as
 * white or black by the picture to either side of the line, and the line is
 * judged only on the columns the line itself covers.
 */
async function dividerReadsOnBothHalves(divider: Locator, picture: Locator, where: string) {
  await painted(picture);
  const line = (await divider.boundingBox())!;
  const box = (await picture.boundingBox())!;
  const png = PNG.sync.read(await picture.screenshot());
  const scale = png.width / box.width;
  const at = (value: number) => Math.round((value - box.x) * scale);
  const from = at(line.x), to = at(line.x + line.width);
  const near = Math.max(3, Math.round(6 * scale));
  expect(from, `${where}: the line is not over the picture`).toBeGreaterThan(near);
  expect(to, `${where}: the line is not over the picture`).toBeLessThan(png.width - near);

  const scan = rows(png);
  const left = from - near, right = to + near;
  const under = (row: number[]) => row.slice(Math.max(0, from - 2), Math.min(png.width, to + 2));
  const white: number[] = [], black: number[] = [];
  scan.forEach((row, index) => {
    if (row[left]! > 200 && row[right]! > 200) white.push(index);
    else if (row[left]! < 25 && row[right]! < 25) black.push(index);
  });
  expect(white.length, `${where}: found no white part of the picture beside the line`).toBeGreaterThan(8);
  // Only the black rows inside the picture count. In the expanded view the
  // picture is letterboxed, and what is above and below it is dark as well.
  const lastWhite = white[white.length - 1]!;
  const inPicture = black.filter((index) => index > lastWhite && index <= lastWhite + white.length);
  expect(inPicture.length, `${where}: found no black part of the picture beside the line`).toBeGreaterThan(8);

  const darkestOnWhite = Math.min(...white.map((index) => Math.min(...under(scan[index]!))));
  const lightestOnBlack = Math.max(...inPicture.map((index) => Math.max(...under(scan[index]!))));
  expect(darkestOnWhite, `${where}: the line cannot be seen against the white half of the picture`).toBeLessThan(100);
  expect(lightestOnBlack, `${where}: the line cannot be seen against the black half of the picture`).toBeGreaterThan(155);
}

test('a wide, short wipe comparison keeps its labels and zoom button clear of the picture', async ({ page, request, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const run = process.env.WORKBENCH_E2E_RUN!;
  const comparison = comparisonOf(
    await chipRow(browser, join(run, 'chips-before.png'), 12),
    await chipRow(browser, join(run, 'chips-after.png'), 4),
    BEFORE_ALT, AFTER_ALT);

  let project: { id: string } | null = null;
  try {
    project = await chatShowing(page, request, comparison, 'managed-short-comparison', 'Short comparison proof');

    const frame = page.locator('[data-widget="image_compare"]');
    const picture = frame.getByRole('img', { name: AFTER_ALT });
    const zoom = frame.getByRole('button', { name: 'Open comparison to zoom' });
    await expect(picture).toBeVisible();
    await expect(zoom).toBeVisible();
    await frame.scrollIntoViewIfNeeded();
    await frame.screenshot({ path: 'tests/results/image-compare-short.png' });

    const [pictureBox, zoomBox, beforeBox, afterBox] = await Promise.all([
      picture.boundingBox(), zoom.boundingBox(), frame.getByTestId('comparison-before-label').boundingBox(), frame.getByTestId('comparison-after-label').boundingBox(),
    ]);
    if (!pictureBox || !zoomBox || !beforeBox || !afterBox) throw new Error('Expected the picture, its labels and its zoom button to be laid out');
    // The picture is a short strip, which is the whole case.
    expect(pictureBox.height).toBeLessThan(48);
    // Neither label nor the button lies on the picture.
    expect(overlaps(beforeBox, pictureBox), 'before label covers the picture').toBe(false);
    expect(overlaps(afterBox, pictureBox), 'after label covers the picture').toBe(false);
    expect(overlaps(zoomBox, pictureBox), 'zoom button covers the picture').toBe(false);
    // The whole button is inside the frame that clips its contents, so no edge
    // of it is cut off — which is what the overflow did to it before.
    const frameBox = (await frame.boundingBox())!;
    expect(zoomBox.y, 'the zoom button is cut off at the top').toBeGreaterThanOrEqual(frameBox.y);
    expect(zoomBox.y + zoomBox.height, 'the zoom button is cut off at the bottom').toBeLessThanOrEqual(frameBox.y + frameBox.height);
    expect(zoomBox.x + zoomBox.width, 'the zoom button is cut off at the side').toBeLessThanOrEqual(frameBox.x + frameBox.width);
    // Its round face answers a click across its full height, top edge to bottom.
    const face = await zoom.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const mid = [box.left + box.width / 2, box.top + box.height / 2] as const;
      const points = [mid, [mid[0], box.top + 2], [mid[0], box.bottom - 2], [box.left + 2, mid[1]], [box.right - 2, mid[1]]] as const;
      return points.map(([x, y]) => button.contains(document.elementFromPoint(x, y)));
    });
    expect(face, 'part of the zoom button is covered or clipped away').toEqual([true, true, true, true, true]);

    // Expanded, the line between the two pictures is what you drag, and the
    // labels read as the same two columns the inline widget uses.
    await zoom.click();
    const dialog = page.getByTestId('picture-viewer');
    await expect(dialog).toBeVisible();
    const split = dialog.getByRole('slider', { name: 'Before and after split' });
    await expect(split).toHaveAttribute('aria-valuenow', '50');
    expect(await dialog.locator('input[type=range]').count(), 'the expanded view still has a bare range control').toBe(0);

    const viewport = dialog.getByTestId('comparison-zoom-viewport');
    const viewportBox = (await viewport.boundingBox())!;
    const splitBox = (await split.boundingBox())!;
    await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + splitBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(viewportBox.x + viewportBox.width * 0.75, splitBox.y + splitBox.height / 2, { steps: 8 });
    await page.mouse.up();
    const dragged = Number(await split.getAttribute('aria-valuenow'));
    expect(dragged, 'dragging the line did not move the split').toBeGreaterThan(65);
    expect(dragged).toBeLessThanOrEqual(100);

    // Two columns, each a real share of the width, and neither on top of the other.
    const [beforeLabel, afterLabel] = await Promise.all([
      dialog.getByTestId('comparison-before-label').boundingBox(), dialog.getByTestId('comparison-after-label').boundingBox(),
    ]);
    if (!beforeLabel || !afterLabel) throw new Error('Expected both labels under the expanded picture');
    expect(overlaps(beforeLabel, afterLabel), 'the expanded labels sit on top of each other').toBe(false);
    expect(beforeLabel.width).toBeGreaterThan(300);
    expect(afterLabel.width).toBeGreaterThan(300);
    expect(Math.abs(beforeLabel.y - afterLabel.y), 'the two labels do not start on the same line').toBeLessThanOrEqual(2);
    await page.screenshot({ path: 'tests/results/image-compare-short-expanded.png' });

    // The keyboard reaches it too.
    await split.press('ArrowLeft');
    expect(Number(await split.getAttribute('aria-valuenow'))).toBe(dragged - 2);
  } finally { if (project) await request.delete(`/api/projects/${project.id}`); }
});

test('the line between the two pictures can be found on a white one and a black one', async ({ page, request, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const run = process.env.WORKBENCH_E2E_RUN!;
  const comparison = comparisonOf(
    await bands(browser, join(run, 'bands-before.png'), '#888'),
    await bands(browser, join(run, 'bands-after.png'), '#555'),
    PALE_ALT, DARK_ALT);

  let project: { id: string } | null = null;
  try {
    project = await chatShowing(page, request, comparison, 'managed-two-tone-divider', 'Two-tone divider proof');

    const frame = page.locator('[data-widget="image_compare"]');
    const picture = frame.getByRole('img', { name: DARK_ALT });
    await expect(picture).toBeVisible();
    await frame.scrollIntoViewIfNeeded();
    // Captured before it is judged, so a run that fails still says what it saw.
    // `animations: 'disabled'` finishes the dialog's fade before the shutter;
    // without it the expanded shot catches the overlay half painted.
    await painted(picture);
    await frame.screenshot({ path: 'tests/results/image-compare-divider.png', animations: 'disabled' });
    await dividerReadsOnBothHalves(frame.getByTestId('comparison-divider'), picture, 'inline');

    await frame.getByRole('button', { name: 'Open comparison to zoom' }).click();
    const dialog = page.getByTestId('picture-viewer');
    await expect(dialog).toBeVisible();
    const expanded = dialog.locator('[data-testid=comparison-transform-after] img');
    await painted(expanded);
    await page.screenshot({ path: 'tests/results/image-compare-divider-expanded.png', animations: 'disabled' });
    await dividerReadsOnBothHalves(dialog.getByTestId('comparison-divider'), expanded, 'expanded');
  } finally { if (project) await request.delete(`/api/projects/${project.id}`); }
});
