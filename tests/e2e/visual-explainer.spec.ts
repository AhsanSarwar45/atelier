import { expect, test } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

const CHAT = 'visual-explainer-fixture';
const explainer = {
  type: 'explainer' as const,
  title: 'How a recovered chat catches up',
  summary: 'A saved sequence number lets Atelier replay only what the browser missed.',
  nodes: [
    { id: 'disconnect', label: 'Connection drops', detail: 'The agent keeps working.' },
    { id: 'replay', label: 'Replay events', detail: 'Resume after sequence 184.' },
    { id: 'live', label: 'Live again', detail: 'New words stream normally.' },
  ],
  edges: [
    { from: 'disconnect', to: 'replay', label: 'reconnect' },
    { from: 'replay', to: 'live', label: 'caught up' },
  ],
  steps: [
    { label: 'The browser loses its connection', detail: 'Work continues in the isolated agent process.', active: ['disconnect'] },
    { label: 'Only missed events are replayed', detail: 'The last sequence number is the cursor.', active: ['replay'] },
    { label: 'The transcript returns to live streaming', detail: 'No duplicate words and no lost tool calls.', active: ['live'] },
  ],
  evidence: [{ label: 'Session protocol', path: `${process.cwd()}/src/workbench/protocol.ts`, line: 13 }],
};
test('an explainer is readable, animated, and directly steerable', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const before = process.env.VISUAL_EXPLAINER_BEFORE === '1';
  const shown = before ? { ...explainer, type: 'unsupported-explainer' } : explainer;
  const source = `A visual explanation is easier to scan than another paragraph.\n\n\`\`\`atelier-widget\n${JSON.stringify(shown)}\n\`\`\``;
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'codex', externalId: 'fixture', model: 'gpt-5', cwd: process.cwd(), permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: source },
    { ...base, seq: 4, type: 'widget', messageId: 'answer', widget: explainer },
    { ...base, seq: 5, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 6, type: 'session.state', state: 'idle', label: 'Ready' },
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'codex', projectId: 'fixture', title: 'Visual explainer', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Visual explainer', cwd: process.cwd(), beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Visual explainer fixture', path: process.cwd(), isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Visual explainer' }).getByTestId('row-name').click();
    if (before) {
      await page.screenshot({ path: process.env.VISUAL_EXPLAINER_SCREENSHOT || 'tests/results/visual-explainer-before.png', fullPage: false });
      return;
    }
    const widget = page.getByTestId('chat-widget').filter({ has: page.getByText('How a recovered chat catches up') });
    await expect(widget).toBeVisible();
    await widget.getByRole('button', { name: 'Step 2: Only missed events are replayed' }).click();
    await expect(widget.getByText('Only missed events are replayed')).toBeVisible();
    await expect(widget.getByText('Replay events').locator('..')).toHaveAttribute('data-active', 'true');
    await page.waitForTimeout(550);
    await page.screenshot({ path: process.env.VISUAL_EXPLAINER_SCREENSHOT || 'tests/results/visual-explainer-after.png', fullPage: false });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
  }
});
