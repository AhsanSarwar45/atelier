import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { makeFixtureProject, PARENT_CARD } from './fixture-board';

const CHAT = 'chat-badges-fixture';

test('provider formatting differences share card and typed file badges', async ({ page, request }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  const run = join(process.cwd(), 'tests', '.workbench-run-badges');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const text = [
    `Open card in prose: ${PARENT_CARD} is ready.`,
    '',
    'Closed card in Markdown: `wl-kid1` landed.',
    '',
    'Changed [message renderer](</home/ahsan/dev/beads-web/src/components/markdown-body.tsx:132>) and captured [visual proof](</home/ahsan/dev/beads-web/tests/results/chat-badges-after.png>).',
  ].join('\n');
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'codex', externalId: 'fixture', model: 'gpt-5', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const snapshot = foldAll(events);

  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
        })), 0);
      }
      close() { this.readyState = FixtureSocket.CLOSED; }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, view: snapshot });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'codex', title: 'Shared chat badges', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Shared chat badges', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Shared chat badge fixture', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Shared chat badges' }).getByTestId('row-name').click();
    await expect(page.getByText('Open card in prose:')).toBeVisible();
    await expect(page.getByTestId('mention-card')).toHaveCount(2);
    await expect(page.locator('[data-bead-status="open"]')).toHaveCount(1);
    await expect(page.locator('[data-bead-status="closed"]')).toHaveCount(1);
    await expect(page.getByTestId('markdown-file-link')).toHaveCount(2);
    await page.screenshot({ path: process.env.CHAT_BADGES_SCREENSHOT || 'tests/results/chat-badges-after.png', fullPage: false });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(run, { recursive: true, force: true });
  }
});
