import { expect, test } from '@playwright/test';
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import type { ExplainerWidget } from '../../src/workbench/chat-widgets';

const CHAT = 'visual-gallery';
const base = {
  type: 'explainer' as const,
  nodes: [{ id: 'client', label: 'Client' }, { id: 'api', label: 'API' }, { id: 'store', label: 'Store' }],
  edges: [{ from: 'client', to: 'api', label: 'request' }, { from: 'api', to: 'store', label: 'query' }, { from: 'store', to: 'client', label: 'result' }],
  steps: [{ label: 'Start at the client', active: ['client'] }, { label: 'Move through the API', active: ['api'] }, { label: 'Reach durable state', active: ['store'] }],
};
const visuals: ExplainerWidget[] = [
  { ...base, layout: 'flow', title: 'Branching flow', summary: 'See relationships fan across a system.' },
  { ...base, layout: 'sequence', title: 'Message sequence', summary: 'Follow calls between actors over time.' },
  { ...base, layout: 'cycle', title: 'Feedback cycle', summary: 'See a process return to its beginning.' },
  { ...base, layout: 'layers', title: 'System layers', summary: 'Move down through an architecture.' },
];

test('four animated visual languages share one conversation', async ({ page, request }) => {
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'gallery', brand: 'codex', title: 'Animated gallery', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'gallery', runningElsewhere: false, held: null, title: 'Animated gallery', cwd: process.cwd(), beads: [] } }));
  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Animated visual gallery', path: process.cwd(), isTest: true } });
    expect(made.status(), await made.text()).toBe(201); project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Animated gallery' }).getByTestId('row-name').click();
    for (const visual of visuals) await expect(page.getByRole('img', { name: `${visual.title} ${visual.layout} diagram, step 1 of 3` })).toBeVisible();
    const sequence = page.getByRole('img', { name: /Message sequence sequence diagram/ });
    await sequence.locator('..').getByRole('button', { name: 'Step 2: Move through the API' }).click();
    await expect(sequence.locator('[data-node="api"]')).toHaveAttribute('data-active', 'true');
    await page.waitForTimeout(550);
    await page.getByRole('img', { name: /Branching flow flow diagram/ }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'tests/results/visual-explainer-gallery-after.png', fullPage: true });
  } finally { if (project) await request.delete(`/api/projects/${project.id}`); }
});
