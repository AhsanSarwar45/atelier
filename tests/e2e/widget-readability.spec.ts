import { expect, test as baseTest, chromium } from '@playwright/test';
const test = baseTest.extend({ browser: [async ({}, use) => { const browser = await chromium.connectOverCDP(process.env.CDP_URL!); await use(browser); }, { scope: 'worker' }] });
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import type { ChatWidget } from '../../src/workbench/chat-widgets';

const CHAT = 'visual-gallery';
const base = {
  type: 'explainer' as const,
  nodes: [{ id: 'client', label: 'Client' }, { id: 'api', label: 'API' }, { id: 'store', label: 'Store' }],
  edges: [{ from: 'client', to: 'api', label: 'request' }, { from: 'api', to: 'store', label: 'query' }, { from: 'store', to: 'client', label: 'result' }],
  steps: [{ label: 'Start at the client', active: ['client'] }, { label: 'Move through the API', active: ['api'] }, { label: 'Reach durable state', active: ['store'] }],
};
const visuals: ChatWidget[] = [
  { type: 'chart', chart: 'bar', title: 'Change in response time (ms)', series: [{ name: 'Change (ms)' }], data: [{ label: 'Cached', values: [-40] }, { label: 'Uncached', values: [20] }, { label: 'Unchanged', values: [0] }] },
  { ...base, layout: 'flow', title: 'Branching flow', summary: 'See relationships fan across a system.' },
  { ...base, layout: 'sequence', title: 'Message sequence', summary: 'Follow calls between actors over time.' },
  { ...base, layout: 'cycle', title: 'Feedback cycle', summary: 'See a process return to its beginning.' },
  { ...base, layout: 'layers', title: 'System layers', summary: 'Move down through an architecture.' },
];

test('charts and explanations remain readable while paused and during playback', async ({ page, request }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 2100 });
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
    for (const visual of visuals.filter((v) => v.type === 'explainer')) await expect(page.getByRole('img', { name: `${visual.title} ${visual.layout} diagram, step 1 of 3` })).toBeVisible();
    await page.locator('[data-widget="chart"]').first().screenshot({ path: `/tmp/bw-9rdk8-chart-${process.env.WIDGET_PROOF_PHASE ?? 'after'}.png` });
    const sequence = page.getByRole('img', { name: /Message sequence sequence diagram/ });
    await sequence.locator('..').getByRole('button', { name: 'Step 2: Move through the API' }).click();
    await expect(sequence.locator('[data-node="api"]')).toHaveAttribute('data-active', 'true');
    await expect(sequence.locator('[data-node="client"]')).toHaveAttribute('data-accent', 'var(--color-info-accent)');
    await expect(sequence.locator('[data-node="api"]')).toHaveAttribute('data-accent', 'var(--color-warning-accent)');
    await page.waitForTimeout(550);
    await page.getByRole('img', { name: /Branching flow flow diagram/ }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/bw-9rdk8-${process.env.WIDGET_PROOF_PHASE ?? 'after'}.png`, fullPage: true });
    if (process.env.WIDGET_PROOF_PHASE !== 'before') {
      const chart = page.locator('[data-widget="chart"]').first();
      await chart.getByText('View data').click();
      await expect(chart.getByRole('cell', { name: '-40', exact: true })).toBeVisible();
      const bars = await chart.locator('rect[data-value]').evaluateAll(elements => elements.map(el => ({ value: Number(el.getAttribute('data-value')), y: Number(el.getAttribute('y')), height: Number(el.getAttribute('height')) })));
      expect(bars[0]!.height).toBeCloseTo(120);
      expect(bars[1]!.height).toBeCloseTo(60);
      expect(bars[0]!.y).toBeCloseTo(bars[1]!.y + bars[1]!.height);
      const flow = page.locator('[data-widget="explainer"]').filter({ hasText: 'Branching flow' });
      await expect(flow.locator('[data-relationship]').first()).toHaveText('ClientAPIrequest');
      const cycle = page.locator('[data-widget="explainer"]').filter({ hasText: 'Feedback cycle' });
      await expect(cycle.locator('[data-relationship]').last()).toHaveText('StoreClientresult');
      await page.clock.install();
      await flow.getByRole('button', { name: 'Play explanation' }).click();
      await page.clock.fastForward(3500);
      await expect(flow.locator('[data-node="api"]')).toHaveAttribute('data-active', 'true');
      await page.clock.fastForward(3500);
      await expect(flow.locator('[data-node="store"]')).toHaveAttribute('data-active', 'true');
      await page.clock.fastForward(3500);
      await expect(flow.getByRole('button', { name: 'Play explanation' })).toBeVisible();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await flow.getByRole('button', { name: 'Step 1: Start at the client' }).click();
      await flow.getByRole('button', { name: 'Play explanation' }).click();
      await page.clock.fastForward(10000);
      await expect(flow.locator('[data-node="client"]')).toHaveAttribute('data-active', 'true');
      await flow.getByRole('button', { name: 'Pause explanation' }).click();
      for (const width of [390, 768, 1024, 1280, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        await chart.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await chart.screenshot({ path: `/tmp/bw-9rdk8-chart-${width}.png` });
      }
      await chart.getByText('View data').focus();
      await page.keyboard.press('Enter');
      await expect(chart.getByRole('button', { name: 'View data' })).toHaveAttribute('aria-expanded', 'false');
      expect(errors).toEqual([]);
    }
  } finally { if (project) await request.delete(`/api/projects/${project.id}`); }
});
