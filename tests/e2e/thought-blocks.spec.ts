import { expect, test } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

const CHAT = 'thought-block-fixture';

test('thoughts show their full Markdown without leading empty space', async ({ page, request }) => {
  await page.setViewportSize({ width: 960, height: 720 });
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'codex', externalId: 'fixture', model: 'gpt-5', cwd: process.cwd(), permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'thinking.delta', messageId: 'thought', text: '\n\n**Assessing service check behavior**\n\nThe complete thought stays readable.\n\n- First detail\n- Second detail' },
    { ...base, seq: 3, type: 'message.completed', messageId: 'thought' },
    { ...base, seq: 4, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 5, type: 'text.delta', messageId: 'answer', text: 'Review complete.' },
    { ...base, seq: 6, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 7, type: 'session.state', state: 'idle', label: 'Ready' },
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'codex', projectId: 'fixture', title: 'Guardian Review', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Guardian Review', cwd: process.cwd(), beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Thought block fixture', path: process.cwd(), isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Guardian Review' }).getByTestId('row-name').click();
    await page.getByTestId('thinking-toggle').click();
    const thought = page.getByTestId('thinking-block');
    await expect(thought).toBeVisible();
    await page.screenshot({ path: process.env.THOUGHT_SCREENSHOT || 'tests/results/thought-block-after.png' });
    if (process.env.THOUGHT_BEFORE === '1') return;

    await expect(thought.getByText('Assessing service check behavior')).toHaveCSS('font-weight', /^(600|700)$/);
    await expect(thought.getByRole('listitem')).toHaveCount(2);
    await expect(thought).toContainText('The complete thought stays readable.');
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
  }
});
