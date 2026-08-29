import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { widgetSpecs, type ChatWidget } from '../../src/workbench/chat-widgets';
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

const CHAT = 'rich-visual-artifacts';
test.setTimeout(90_000);

test('library-powered artifacts interact, expand, and survive reload', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  const run = process.env.WORKBENCH_E2E_RUN!; const fixtures = join(run, 'artifacts'); mkdirSync(fixtures, { recursive: true });
  const values = [
    { version: 1, kind: 'mermaid', title: 'Recovery sequence', source: 'sequenceDiagram\n  participant Browser\n  participant API\n  participant Agent\n  Browser->>API: Reconnect\n  API->>Agent: Resume\n  Agent-->>Browser: Replay missed events' },
    { version: 1, kind: 'flow', title: 'Interactive service map', direction: 'RIGHT', editable: true, nodes: [{ id: 'ui', label: 'Chat UI', color: '#38bdf8' }, { id: 'api', label: 'Atelier API', color: '#f59e0b' }, { id: 'agent', label: 'Agent', color: '#22c55e' }], edges: [{ id: 'ui-api', from: 'ui', to: 'api', animated: true }, { id: 'api-agent', from: 'api', to: 'agent', animated: true }] },
    { version: 1, kind: 'scene', title: 'Animated packet', viewBox: [0, 0, 640, 260], elements: [{ id: 'source', type: 'rect', x: 30, y: 70, width: 150, height: 110, rx: 18, fill: '#0f2740', stroke: '#38bdf8', strokeWidth: 3 }, { id: 'target', type: 'rect', x: 460, y: 70, width: 150, height: 110, rx: 18, fill: '#122d20', stroke: '#22c55e', strokeWidth: 3 }, { id: 'route', type: 'path', d: 'M180 125 C280 30 360 220 460 125', fill: 'none', stroke: '#f59e0b', strokeWidth: 5 }, { id: 'packet', type: 'circle', cx: 180, cy: 125, r: 14, fill: '#f59e0b' }, { id: 'caption', type: 'text', x: 245, y: 235, text: 'Validated request', fill: '#e5e7eb' }], states: [{ id: 'start', label: 'Start', changes: [{ element: 'packet', x: 0 }, { element: 'route', pathLength: .2 }] }, { id: 'validated', label: 'Validated', changes: [{ element: 'packet', x: 215, scale: 1.4 }, { element: 'route', pathLength: .65 }] }, { id: 'delivered', label: 'Delivered', changes: [{ element: 'packet', x: 430 }, { element: 'route', pathLength: 1 }] }] },
    { version: 1, kind: 'mockup', title: 'Clickable checkout', initialScreen: 'cart', viewport: { width: 1200, height: 760 }, screens: [{ id: 'cart', title: 'Checkout', components: [{ id: 'panel', type: 'card', text: 'Complete your order', children: [{ id: 'email', type: 'input', label: 'Email', placeholder: 'you@example.com' }, { id: 'pay', type: 'button', text: 'Pay now', action: { type: 'navigate', screen: 'done' } }] }] }, { id: 'done', title: 'Receipt', components: [{ id: 'success', type: 'card', tone: 'success', children: [{ id: 'heading', type: 'heading', text: 'Payment complete' }, { id: 'again', type: 'button', text: 'Start again', tone: 'neutral', action: { type: 'navigate', screen: 'cart' } }] }] }] },
  ];
  const command = join(process.cwd(), 'server/target/debug/atelier'); const env = { ...process.env, ATELIER_DATA_DIR: join(run, 'data') };
  const widgets: ChatWidget[] = values.map((value, index) => { const file = join(fixtures, `${index}.json`); writeFileSync(file, JSON.stringify(value)); return widgetSpecs(execFileSync(command, ['tool', 'present', 'artifact', '--file', file], { env, encoding: 'utf8' }))[0]!; });
  const common = { sessionId: CHAT, at: new Date(0).toISOString() }; const events: WbpEvent[] = [{ ...common, seq: 1, type: 'session.started', brand: 'codex', externalId: 'visuals', model: 'gpt-5', cwd: process.cwd(), permissionMode: 'on-request' }]; let seq = 2;
  widgets.forEach((widget, index) => { const messageId = `visual-${index}`; events.push({ ...common, seq: seq++, type: 'message.started', messageId, role: 'assistant' }, { ...common, seq: seq++, type: 'text.delta', messageId, text: `\`\`\`atelier-widget\n${JSON.stringify(widget)}\n\`\`\`` }, { ...common, seq: seq++, type: 'widget', messageId, widget }, { ...common, seq: seq++, type: 'message.completed', messageId }); });
  events.push({ ...common, seq, type: 'session.state', state: 'idle', label: 'Ready' }); const snapshot = foldAll(events);
  await page.addInitScript(({ chat, view }) => { class Socket { static OPEN = 1; readyState = 1; onmessage: ((event: MessageEvent) => void) | null = null; constructor(url: string) { if (new URL(url).searchParams.get('chat') === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }) })), 0); } close() { this.readyState = 3; } send() {} } Object.defineProperty(window, 'WebSocket', { value: Socket, configurable: true }); }, { chat: CHAT, view: snapshot });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => { if (route.request().method() !== 'GET') return route.continue(); const url = new URL(route.request().url()); url.searchParams.set('include_test', 'true'); await route.continue({ url: url.toString() }); });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'visuals', brand: 'codex', title: 'Rich visual gallery', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'visuals', runningElsewhere: false, held: null, title: 'Rich visual gallery', cwd: process.cwd(), beads: [] } }));
  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Rich visual proof', path: process.cwd(), isTest: true } }); expect(made.status(), await made.text()).toBe(201); project = await made.json();
    const open = async () => { await page.goto(`/project?id=${project!.id}&tab=chat`); await page.getByTestId('restore-row').filter({ hasText: 'Rich visual gallery' }).getByTestId('row-name').click(); await expect(page.getByTestId('mermaid-artifact')).toBeVisible(); await expect(page.getByTestId('flow-artifact')).toBeVisible(); await expect(page.getByTestId('scene-artifact')).toBeVisible(); await expect(page.getByTestId('mockup-artifact')).toBeVisible(); };
    await open();
    await page.getByRole('button', { name: 'Delivered' }).click(); await expect(page.getByRole('img', { name: 'Animated packet: Delivered' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Email' }).fill('person@example.com'); await page.getByRole('button', { name: 'Pay now' }).click(); await expect(page.getByRole('heading', { name: 'Payment complete' })).toBeVisible();
    await page.getByRole('button', { name: 'Open artifact full screen' }).last().click(); const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible(); await dialog.getByRole('textbox', { name: 'Email' }).fill('fullscreen@example.com'); await dialog.getByRole('button', { name: 'Pay now' }).click(); await expect(dialog.getByRole('heading', { name: 'Payment complete' })).toBeVisible(); await page.getByRole('button', { name: 'Close full-screen artifact' }).click();
    await page.reload(); await open(); await expect(page.getByRole('button', { name: 'Pay now' })).toBeVisible();
    await page.getByTestId('scene-artifact').scrollIntoViewIfNeeded(); await page.screenshot({ path: 'tests/results/visual-artifacts-after.png', fullPage: false });
    await page.getByRole('button', { name: 'Open artifact full screen' }).last().click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.screenshot({ path: 'tests/results/visual-mockup-fullscreen-after.png', fullPage: false }); await page.getByRole('button', { name: 'Close full-screen artifact' }).click();
  } finally { if (project) await request.delete(`/api/projects/${project.id}`); }
});
