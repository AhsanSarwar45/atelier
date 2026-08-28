import { expect, test } from '@playwright/test';

import type { WbpEvent } from '../../src/workbench/protocol';
import { foldAll } from '../../src/workbench/fold';
import { replayCodexRollout } from '../../workbench/src/drivers/codex';

const CHAT = 'codex-history-chat';
const PROMPT = 'Please keep this prompt visible when I reopen the chat.';
const ANSWER = 'The prompt should be directly above this answer.';

test('an old Codex chat shows the person’s messages', async ({ page, request }) => {
  const bare: Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>[] = [];
  replayCodexRollout([
    { timestamp: '2026-08-28T05:00:01.000Z', type: 'event_msg', payload: {
      type: 'user_message', message: PROMPT, images: [], local_images: [],
    } },
    { timestamp: '2026-08-28T05:00:02.000Z', type: 'response_item', payload: {
      type: 'message', id: 'answer', role: 'assistant',
      content: [{ type: 'output_text', text: ANSWER }], phase: 'final_answer',
    } },
  ].map((row) => JSON.stringify(row)).join('\n'), (event) => bare.push(event));
  const events = bare.map((event, index) => ({
    ...event, seq: index + 1, sessionId: CHAT, at: new Date(0).toISOString(),
  })) as WbpEvent[];
  const full = foldAll(events);
  const view = {
    ...full,
    brand: 'codex',
    state: 'dormant',
    stateLabel: 'Asleep',
    items: process.env.CODEX_HISTORY_EXPECT_USER === '0'
      ? full.items.filter((item) => item.kind !== 'message' || item.role !== 'user')
      : full.items,
  };

  await page.addInitScript(({ chat, snapshot }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(url: string) {
        const selected = new URL(url).searchParams.get('chat');
        if (selected === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(snapshot) }),
        })), 0);
      }

      close() { this.readyState = FixtureSocket.CLOSED; }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, snapshot: view });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{
    sessionId: CHAT, externalId: 'codex-thread', brand: 'codex', projectId: 'fixture',
    title: PROMPT, state: 'dormant', lastActiveAt: '2026-08-28T05:00:03.000Z',
    cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [],
  }] }));
  await page.route(/\/api\/workbench\/command$/, (route) => route.fulfill({ json: { id: CHAT } }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: {
    sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'codex-thread',
    runningElsewhere: false, held: null, title: PROMPT, cwd: process.cwd(),
    folder: 'bw-12xw', branch: 'bw-12xw', beads: [],
  } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'Codex history fixture', path: process.cwd(), isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.locator('[data-testid="restore-row"]', { hasText: PROMPT }).getByTestId('row-name').click();
    await expect(page.getByTestId('assistant-message')).toContainText(ANSWER);

    const prompt = page.getByTestId('user-message').filter({ hasText: PROMPT });
    if (process.env.CODEX_HISTORY_EXPECT_USER === '0') await expect(prompt).toHaveCount(0);
    else await expect(prompt).toHaveCount(1);
    await page.screenshot({
      path: process.env.CODEX_HISTORY_SCREENSHOT || '/tmp/atelier-bw-12xw-after.png',
      fullPage: true,
    });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
  }
});
