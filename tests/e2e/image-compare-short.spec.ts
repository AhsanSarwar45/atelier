import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser } from '@playwright/test';

import { widgetSpecs, type ChatWidget } from '../../src/workbench/chat-widgets';
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * A wipe comparison of a wide, short picture is still readable.
 *
 * The manager's own proof on 2026-09-03 was a chip row a few dozen pixels
 * tall: the before and after labels, laid over the picture as chips, were
 * wider than it was and hid it entirely, and the zoom button pinned to the
 * picture's top corner ran off its bottom edge and was cut in half (bw-7v5c).
 * Labels and the button now sit in a row of their own under the picture, so
 * they cannot cover it and nothing clips them.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/image-compare-short.spec.ts
 */

const CHAT = 'managed-short-comparison';
const BEFORE_ALT = 'Every chip on the line at its own distance from the next, so the limit pair reads as the only two that are joined';
const AFTER_ALT = 'One distance between every pair of chips on the line, so the whole row reads as one run and nothing on it looks joined';

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

test('a wide, short wipe comparison keeps its labels and zoom button clear of the picture', async ({ page, request, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const run = process.env.WORKBENCH_E2E_RUN!;
  const before = await chipRow(browser, join(run, 'chips-before.png'), 12);
  const after = await chipRow(browser, join(run, 'chips-after.png'), 4);
  const command = join(process.cwd(), 'server/target/debug/atelier');
  const comparison: ChatWidget = widgetSpecs(execFileSync(command, ['tool', 'present', 'compare',
    '--before', before, '--after', after, '--before-alt', BEFORE_ALT, '--after-alt', AFTER_ALT, '--mode', 'wipe'], { encoding: 'utf8' }))[0]!;

  const common = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...common, seq: 1, type: 'session.started', brand: 'codex', externalId: 'short', model: 'gpt-5', cwd: process.cwd(), permissionMode: 'on-request' },
    { ...common, seq: 2, type: 'message.started', messageId: 'short-0', role: 'assistant' },
    { ...common, seq: 3, type: 'text.delta', messageId: 'short-0', text: `\`\`\`atelier-widget\n${JSON.stringify(comparison)}\n\`\`\`` },
    { ...common, seq: 4, type: 'widget', messageId: 'short-0', widget: comparison },
    { ...common, seq: 5, type: 'message.completed', messageId: 'short-0' },
    { ...common, seq: 6, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const snapshot = foldAll(events);

  await page.addInitScript(({ chat, view }) => {
    class Socket {
      static OPEN = 1; readyState = 1;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) { if (new URL(url).searchParams.get('chat') === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }) })), 0); }
      close() { this.readyState = 3; } send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: Socket, configurable: true });
  }, { chat: CHAT, view: snapshot });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => { if (route.request().method() !== 'GET') return route.continue(); const url = new URL(route.request().url()); url.searchParams.set('include_test', 'true'); await route.continue({ url: url.toString() }); });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'short', brand: 'codex', title: 'Short comparison', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'short', runningElsewhere: false, held: null, title: 'Short comparison', cwd: process.cwd(), beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Short comparison proof', path: process.cwd(), isTest: true } });
    expect(made.status(), await made.text()).toBe(201); project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Short comparison' }).getByTestId('row-name').click();

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
    // labels read as the same two columns the inline widget uses. What the
    // manager found here was a line that would not move and a bare range
    // input drawn as an unexplained grey circle between two squeezed labels
    // (bw-kcri).
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
