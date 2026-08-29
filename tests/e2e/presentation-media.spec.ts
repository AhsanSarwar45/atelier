import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import { widgetSpecs, type ChatWidget } from '../../src/workbench/chat-widgets';
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

const CHAT = 'managed-presentation-media';

test('CLI-produced media survives a chat reload', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  const run = process.env.WORKBENCH_E2E_RUN!;
  const denied = join(run, 'agent-cannot-own-data');
  writeFileSync(denied, 'this is a file, so no command can create a media directory beneath it');
  const env = { ...process.env, ATELIER_DATA_DIR: denied };
  const command = join(process.cwd(), 'server/target/debug/atelier');
  const make = (args: string[]) => widgetSpecs(execFileSync(command, ['tool', 'present', ...args], { env, encoding: 'utf8' }))[0]!;
  const image = make(['image', '--file', 'tests/results/visual-explainer-color-after.png', '--alt', 'Colored explainer gallery', '--caption', 'Four semantic layouts']);
  const comparison = make(['compare', '--before', 'tests/results/visual-explainer-gallery-after.png', '--after', 'tests/results/visual-explainer-color-after.png', '--before-alt', 'Monochrome gallery', '--after-alt', 'Colored gallery', '--mode', 'side_by_side']);
  const visuals: ChatWidget[] = [image, comparison];

  const common = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [{ ...common, seq: 1, type: 'session.started', brand: 'codex', externalId: 'media', model: 'gpt-5', cwd: process.cwd(), permissionMode: 'on-request' }];
  let seq = 2;
  visuals.forEach((widget, index) => {
    const messageId = `media-${index}`;
    events.push(
      { ...common, seq: seq++, type: 'message.started', messageId, role: 'assistant' },
      { ...common, seq: seq++, type: 'text.delta', messageId, text: `\`\`\`atelier-widget\n${JSON.stringify(widget)}\n\`\`\`` },
      { ...common, seq: seq++, type: 'widget', messageId, widget },
      { ...common, seq: seq++, type: 'message.completed', messageId },
    );
  });
  events.push({ ...common, seq, type: 'session.state', state: 'idle', label: 'Ready' });
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'media', brand: 'codex', title: 'Durable visuals', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'media', runningElsewhere: false, held: null, title: 'Durable visuals', cwd: process.cwd(), beads: [] } }));
  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Durable visual proof', path: process.cwd(), isTest: true } });
    expect(made.status(), await made.text()).toBe(201); project = await made.json();
    const open = async () => {
      await page.goto(`/project?id=${project!.id}&tab=chat`);
      await page.getByTestId('restore-row').filter({ hasText: 'Durable visuals' }).getByTestId('row-name').click();
      await expect(page.getByRole('img', { name: 'Colored explainer gallery' })).toBeVisible();
      await expect(page.getByRole('img', { name: 'Monochrome gallery' })).toBeVisible();
      await expect(page.getByRole('img', { name: 'Colored gallery' })).toBeVisible();
    };
    await open();
    await page.reload();
    await open();
    await page.getByRole('img', { name: 'Colored explainer gallery' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'tests/results/presentation-media-after.png', fullPage: true });
  } finally { if (project) await request.delete(`/api/projects/${project.id}`); }
});
