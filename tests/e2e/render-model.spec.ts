import { expect, test as baseTest, chromium } from '@playwright/test';
const test = baseTest.extend({ browser: [async ({}, use) => { const browser = await chromium.connectOverCDP(process.env.CDP_URL!); await use(browser); }, { scope: 'worker' }] });
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import type { ChatWidget } from '../../src/workbench/chat-widgets';

const CHAT = 'visual-gallery';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { widgetSpecs } from '../../src/workbench/chat-widgets';

test('computed rendering compares real buffers and recomputes parameter changes', async ({ page, request }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 2100 });
  const visuals: ChatWidget[] = ['render-taa', 'render-filter', 'legacy-scene'].map(name => widgetSpecs(execFileSync(process.env.ATELIER_BINARY!, ['tool', 'present', 'artifact', '--file', join(process.cwd(), 'tests/fixtures', `${name}.json`)], { env: process.env, encoding: 'utf8' }))[0]!);
  const common = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [{ ...common, seq: 1, type: 'session.started', brand: 'codex', externalId: 'gallery', model: 'gpt-5', cwd: process.cwd(), permissionMode: 'on-request' }];
  let seq = 2;
  visuals.forEach((visual, index) => {
    const messageId = `visual-${index}`;
    events.push(
      { ...common, seq: seq++, type: 'message.started', messageId, role: 'assistant' },
      { ...common, seq: seq++, type: 'text.delta', messageId, text: `\`\`\`atelier-widget\n${JSON.stringify(visual)}\n\`\`\`` },
      { ...common, seq: seq++, type: 'widget', messageId, widget: visual },
      { ...common, seq: seq++, type: 'message.completed', messageId },
    );
  });
  events.push({ ...common, seq, type: 'session.state', state: 'idle', label: 'Ready' });
  const snapshot = foldAll(events);
  await page.addInitScript(({ chat, view }) => {
    class Socket {
      static OPEN = 1; static CLOSED = 3; readyState = 1;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) { if (new URL(url).searchParams.get('chat') === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }) })), 0); }
      close() { this.readyState = 3; } send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: Socket, configurable: true });
  }, { chat: CHAT, view: snapshot });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => { if (route.request().method() !== 'GET') return route.continue(); const url = new URL(route.request().url()); url.searchParams.set('include_test', 'true'); await route.continue({ url: url.toString() }); });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'gallery', brand: 'codex', title: 'Animated gallery', name: 'Animated gallery', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'gallery', runningElsewhere: false, held: null, title: 'Animated gallery', name: 'Animated gallery', cwd: process.cwd(), beads: [] } }));
  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Animated visual gallery', path: process.cwd(), isTest: true } });
    expect(made.status(), await made.text()).toBe(201); project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Animated gallery' }).getByTestId('row-name').click();
    await page.bringToFront();
    const rendering = page.getByTestId('render-artifact');
    const taa = rendering.nth(0); const filter = rendering.nth(1);
    await expect(taa).toHaveAttribute('aria-busy', 'false');
    await expect(filter).toHaveAttribute('aria-busy', 'false');
    await expect(taa.locator('[data-view]')).toHaveCount(4);
    await taa.getByRole('slider', { name: 'Frame', exact: true }).fill('1');
    await taa.getByRole('spinbutton', { name: 'Pixel X' }).fill('4');
    await taa.getByRole('spinbutton', { name: 'Pixel Y' }).fill('8');
    const row = (id: string) => taa.locator(`[data-buffer-row="${id}"]`).locator('td').nth(1);
    await expect(row('color')).toContainText('R: 0.08');
    await expect(row('naive')).toContainText('R: 0.777');
    await expect(row('resolved')).toContainText('R: 0.08');
    await expect(row('valid')).toHaveText('Valid: 0');
    for (const pane of await taa.locator('[data-view]').all()) await expect(pane).toHaveAttribute('data-frame', '1');
    for (const canvas of await taa.locator('canvas').all()) await expect(canvas).toHaveAttribute('data-pixel', '4,8');
    await taa.locator('canvas').first().focus(); await page.keyboard.press('ArrowRight');
    await expect(taa.getByRole('spinbutton', { name: 'Pixel X' })).toHaveValue('5');
    await taa.getByRole('spinbutton', { name: 'Pixel X' }).fill('4');
    // Verify actual displayed bytes away from the selection outline, not only text.
    const colors = await taa.locator('[data-view="resolved"] canvas').evaluate((el: HTMLCanvasElement) => Array.from(el.getContext('2d')!.getImageData(3, 8, 1, 1).data));
    expect(colors[3]).toBe(255); expect(colors[2]).toBeGreaterThan(colors[0]!);
    await taa.screenshot({ path: '/tmp/bw-wo02r-taa.png' });
    await taa.getByRole('slider', { name: 'Depth threshold' }).fill('1');
    await expect(taa).toHaveAttribute('aria-busy', 'false');
    await expect(row('valid')).toHaveText('Valid: 1');
    await expect(row('resolved')).toContainText('R: 0.777');
    await taa.getByRole('slider', { name: 'History weight' }).fill('0');
    await expect(taa).toHaveAttribute('aria-busy', 'false');
    await expect(row('naive')).toContainText('R: 0.08');
    await taa.getByRole('slider', { name: 'History weight' }).fill('0.5');
    await taa.getByRole('slider', { name: 'History weight' }).fill('0.85');
    await taa.getByRole('slider', { name: 'Depth threshold' }).fill('0.05');
    await expect(taa).toHaveAttribute('aria-busy', 'false');
    await expect(row('resolved')).toContainText('R: 0.08');
    await expect(row('naive')).toContainText('R: 0.777');
    await taa.getByRole('combobox', { name: 'Inspect buffer' }).click();
    await page.getByRole('option', { name: 'Motion vectors', exact: true }).click();
    await expect(taa.locator('canvas').last()).toHaveAttribute('data-buffer', 'motion');
    await taa.getByRole('spinbutton', { name: 'Pixel X' }).fill('10');
    await expect(row('motion')).toHaveText('X: 1 · Y: 0');
    await expect(row('history')).toContainText('R: 0.9');
    await taa.getByRole('button', { name: 'Reset parameters' }).click();
    await expect(taa).toHaveAttribute('aria-busy', 'false');
    await expect(taa.getByTestId('render-frame')).toHaveText('Frame 0 / 11');
    await page.clock.install();
    await taa.getByRole('button', { name: 'Play', exact: true }).click();
    await page.clock.runFor(550);
    await expect(taa.getByTestId('render-frame')).toHaveText('Frame 2 / 11');
    await taa.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.clock.runFor(500);
    await expect(taa.getByTestId('render-frame')).toHaveText('Frame 2 / 11');
    await taa.getByRole('button', { name: 'Replay', exact: true }).click();
    await page.clock.runFor(3500);
    await expect(taa.getByTestId('render-frame')).toHaveText('Frame 11 / 11');
    await expect(taa.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await page.clock.runFor(2000);
    await expect(taa.getByTestId('render-frame')).toHaveText('Frame 11 / 11');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(taa.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
    await taa.getByRole('button', { name: 'Previous frame' }).click();
    await expect(taa.getByTestId('render-frame')).toHaveText('Frame 10 / 11');
    await expect(filter.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
    await filter.getByRole('spinbutton', { name: 'Pixel X' }).fill('11');
    await filter.getByRole('spinbutton', { name: 'Pixel Y' }).fill('8');
    const sharpened = filter.locator('[data-buffer-row="sharpen"]').locator('td').nth(1);
    await expect(sharpened).toHaveText('Luma: 1.033333');
    await filter.getByRole('slider', { name: 'Sharpening amount' }).fill('0');
    await expect(filter).toHaveAttribute('aria-busy', 'false');
    await expect(sharpened).toHaveText('Luma: 0.8');
    await filter.getByRole('slider', { name: 'Sharpening amount' }).fill('1');
    await expect(filter).toHaveAttribute('aria-busy', 'false');
    await filter.screenshot({ path: '/tmp/bw-wo02r-filter.png' });
    const legacy = page.getByTestId('scene-artifact');
    await legacy.getByRole('button', { name: 'Next step' }).click();
    await expect(legacy.getByRole('img', { name: 'Legacy movement: Finish' })).toBeVisible();
    for (const name of ['Hide chats', 'Hide chat details']) {
      const toggle = page.getByRole('button', { name, exact: true });
      if (await toggle.isVisible()) await toggle.click();
    }
    for (const width of [390, 768, 1024, 1280, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.clock.runFor(500); await taa.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await taa.screenshot({ path: `/tmp/bw-wo02r-taa-${width}.png` });
    }
    await page.getByRole('button', { name: 'Open artifact full screen' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('render-artifact')).toHaveAttribute('aria-busy', 'false');
    await dialog.getByRole('button', { name: 'Next frame' }).click();
    await expect(dialog.getByTestId('render-frame')).toHaveText('Frame 1 / 11');
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByTestId('render-artifact').first()).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByTestId('render-frame').first()).toHaveText('Frame 0 / 11');
    expect(errors).toEqual([]);
  } finally { if (project) await request.delete(`/api/projects/${project.id}`); }
});
