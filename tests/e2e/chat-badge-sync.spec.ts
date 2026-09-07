import { expect, test } from '@playwright/test';

import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { OPEN_CARD, PARENT_CARD, bd, discardFixture, makeFixtureProject } from './fixture-board';

const CHAT = 'chat-badge-sync-fixture';
const SHOT = process.env.CHAT_BADGE_SYNC_DIR || 'tests/results';

/**
 * A card wears one colour wherever the chat draws it, and that colour is the
 * board's, now — not the board's when the chat was opened (bw-pq2a).
 *
 * The chat names a card in a message and the rail lists it under Related
 * cards. Both chips read one shared store, and that store has to keep up with
 * the board on its own: the fixture's board is kept in Dolt, whose files the
 * helper cannot watch reliably, so the store asks again on a clock the way
 * the board page does. Closing the card from outside the app must recolour
 * both chips with the page left exactly where it was.
 */
test('a card closed on the board recolours its chip in the message and in the rail without a reload', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1100, height: 720 });
  const run = join(process.cwd(), 'tests', '.workbench-run-badge-sync');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const text = `Working on ${OPEN_CARD} under ${PARENT_CARD} today.`;
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'claude', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const snapshot = foldAll(events);
  const beads = [OPEN_CARD, PARENT_CARD];

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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'claude', title: 'Badge sync', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Badge sync', cwd: projectPath, beads } }));

  // Every chip the page draws for one card, wherever it is drawn.
  const chipsFor = (id: string) => page.locator(`[data-testid="mention-card"], [data-testid="bead-chip"]`).filter({ hasText: new RegExp(`^${id}$`) });
  const bothSay = async (id: string, status: string) => {
    const chips = chipsFor(id);
    await expect(chips, `${id} is drawn in the message and in the rail`).toHaveCount(2);
    for (const chip of await chips.all()) await expect(chip).toHaveAttribute('data-bead-status', status, { timeout: 90_000 });
  };

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Badge sync fixture', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Badge sync' }).getByTestId('row-name').click();
    await expect(page.getByText('Working on')).toBeVisible();
    const rail = page.getByTestId('chat-right-rail');
    if ((await rail.getAttribute('data-open')) !== 'true') await page.getByTestId('chat-right-rail-toggle').click();
    await expect(page.getByTestId('rail-cards')).toBeVisible();

    // Before: the piece and its epic are open, and every chip says so.
    await bothSay(OPEN_CARD, 'open');
    await bothSay(PARENT_CARD, 'open');
    await page.screenshot({ path: `${SHOT}/chat-badge-sync-before.png` });

    // The board moves under the page: the piece is closed by bd, not by the app.
    bd(['close', OPEN_CARD, '--reason', 'closed from outside the app'], projectPath);

    // After: both chips for the piece read closed, with no reload and no click;
    // the epic's own chips keep the epic's own colour.
    await bothSay(OPEN_CARD, 'closed');
    await bothSay(PARENT_CARD, 'open');
    await page.screenshot({ path: `${SHOT}/chat-badge-sync-after.png` });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
