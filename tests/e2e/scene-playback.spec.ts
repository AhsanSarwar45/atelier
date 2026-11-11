import { expect, test as baseTest, chromium } from '@playwright/test';
const test = baseTest.extend({ browser: [async ({}, use) => { const browser = await chromium.connectOverCDP(process.env.CDP_URL!); await use(browser); }, { scope: 'worker' }] });
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import type { ChatWidget } from '../../src/workbench/chat-widgets';

const CHAT = 'visual-gallery';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { widgetSpecs } from '../../src/workbench/chat-widgets';

test('scene scenarios, curved routes and playback work in the chat reader', async ({ page, request }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 2100 });
  const visuals: ChatWidget[] = ['cache-scenarios', 'parcel-route', 'legacy-scene'].map(name => widgetSpecs(execFileSync(process.env.ATELIER_BINARY!, ['tool', 'present', 'artifact', '--file', join(process.cwd(), 'tests/fixtures', `${name}.json`)], { env: process.env, encoding: 'utf8' }))[0]!);
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
    const cache = page.getByTestId('scene-artifact').nth(0);
    const parcel = page.getByTestId('scene-artifact').nth(1);
    await expect(cache.getByRole('combobox', { name: 'Scenario' })).toHaveText('Cache hit');
    await expect(cache.getByText('Step 1 of 3')).toBeVisible();
    const dot = cache.locator('[data-element="request"]');
    await expect(dot).toHaveAttribute('transform', 'translate(70 100)');
    const legacy = page.getByTestId('scene-artifact').nth(2);
    await expect(legacy.getByRole('combobox')).toHaveCount(0);
    await legacy.getByRole('button', { name: 'Next step' }).click();
    await expect(legacy.locator('[data-element="dot"]')).toHaveAttribute('transform', 'translate(300 0)');
    await legacy.getByRole('button', { name: 'Previous step' }).click();
    await expect(legacy.locator('[data-element="dot"]')).toHaveAttribute('transform', 'translate(0 0)');
    await page.clock.install();
    await cache.getByRole('button', { name: 'Play', exact: true }).click();
    await page.clock.runFor(700);
    const moving = await dot.getAttribute('transform');
    expect(moving).not.toBe('translate(70 100)');
    await cache.getByRole('button', { name: 'Pause', exact: true }).click();
    const paused = await dot.getAttribute('transform');
    await page.clock.runFor(1000);
    expect(await dot.getAttribute('transform')).toBe(paused);
    await cache.getByRole('slider').fill('2');
    await expect(dot).toHaveAttribute('transform', 'translate(550 100)');
    await expect(cache.getByText('The database is skipped.')).toBeVisible();
    await cache.getByRole('button', { name: 'Play', exact: true }).click();
    await page.clock.runFor(300);
    await cache.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Cache miss', exact: true }).click();
    await expect(cache.getByText('Step 1 of 4')).toBeVisible();
    await expect(dot).toHaveAttribute('transform', 'translate(70 100)');
    await page.clock.runFor(1000);
    await expect(dot).toHaveAttribute('transform', 'translate(70 100)');
    await cache.getByRole('button', { name: 'Next step' }).click();
    await expect(cache.getByText('The result is missing or expired.')).toBeVisible();
    await cache.getByRole('slider').focus();
    await page.keyboard.press('ArrowRight');
    await expect(cache.getByText('Step 3 of 4')).toBeVisible();
    await cache.screenshot({ path: '/tmp/bw-1i9ht-cache-after.png' });
    await cache.getByRole('button', { name: 'Replay', exact: true }).click();
    await page.clock.runFor(7000);
    await expect(dot).toHaveAttribute('transform', 'translate(550 100)');
    await expect(cache.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await page.clock.runFor(7000);
    await expect(dot).toHaveAttribute('transform', 'translate(550 100)');
    await expect(parcel.getByRole('combobox')).toHaveCount(0);
    await parcel.getByRole('slider').fill('0.5');
    const point = await parcel.locator('[data-element="request"]').evaluate(el => {
      const svg = el.closest('svg')!;
      const path = svg.querySelector('path')!;
      const expected = path.getPointAtLength(path.getTotalLength() * .25);
      const matrix = (el as unknown as SVGGraphicsElement).transform.baseVal.consolidate()!.matrix;
      return { x: matrix.e, y: matrix.f, expectedX: expected.x, expectedY: expected.y };
    });
    expect(point.x).toBeCloseTo(point.expectedX, 3);
    expect(point.y).toBeCloseTo(point.expectedY, 3);
    expect(point.y).toBeLessThan(180);
    await parcel.screenshot({ path: '/tmp/bw-1i9ht-parcel-after.png' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(cache.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
    await cache.getByRole('button', { name: 'Replay', exact: true }).click();
    await page.clock.runFor(7000);
    await expect(dot).toHaveAttribute('transform', 'translate(70 100)');
    await cache.getByRole('button', { name: 'Next step' }).click();
    await expect(cache.getByText('Step 2 of 4')).toBeVisible();
    for (const name of ['Hide chats', 'Hide chat details']) {
      const toggle = page.getByRole('button', { name, exact: true });
      if (await toggle.isVisible()) await toggle.click();
    }
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.keyboard.press('Escape');
      await page.clock.runFor(500);
      await cache.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await cache.screenshot({ path: `/tmp/bw-1i9ht-cache-${width}.png` });
    }
    await page.getByRole('button', { name: 'Open artifact full screen' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('combobox')).toHaveText('Cache hit');
    await dialog.getByRole('button', { name: 'Next step' }).click();
    await expect(dialog.getByText('Step 2 of 3')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByTestId('scene-artifact').first().getByRole('combobox')).toHaveText('Cache hit');
    expect(errors).toEqual([]);
  } finally { if (project) await request.delete(`/api/projects/${project.id}`); }
});
