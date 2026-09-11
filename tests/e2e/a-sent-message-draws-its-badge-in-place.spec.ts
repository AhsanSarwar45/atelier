import { expect, test } from '@playwright/test';

import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

/**
 * A sent message draws each picture where its badge sat (bw-oamr.2).
 *
 * Every picture used to be pinned above the words in one grid however the
 * person had arranged them, and the only trace of where a picture belonged was
 * the app's own `[Image: name]` prose, left behind in the middle of his
 * sentence. Two pictures either side of a sentence came out as two thumbnails
 * on top and two bracketed names in the text.
 *
 * The position travels as a number on the picture now, so the words are only
 * his words and each picture is drawn in its place.
 *
 * Set BADGE_IN_PLACE_BEFORE to seed the same message the old way — the prose in
 * the text, no position on either picture — which is how the "before" half of
 * the evidence is taken.
 */

const CHAT = 'badge-in-place-fixture';

// A 160x100 checkerboard. Big enough to be seen in the evidence: a picture
// too small to make out proves the count and nothing a reader can check.
const PICTURE =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAAAAAAk3WRTAAAAbklEQVR42u3ZMQ0AMAwDsMIp' +
  'fyhDNAK5u6ly7hx+o9QJ6ZBXvQIEBAQEBAQEBAQEXA38CZN6gICAgICAgICAgIC7gVYdICAg' +
  'ICAgICAgIKCfxOwEBAQEBAQEBAQE9JNYdYCAgICAgICAgICA470LgSCGQy0Mr04AAAAASUVO' +
  'RK5CYII=';

test('a sent message draws each picture where its badge sat', async ({ page, request }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  const run = join(process.cwd(), 'tests', '.workbench-run-badge-in-place');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));

  const before = process.env.BADGE_IN_PLACE_BEFORE;
  // How the composer used to write it: its own prose where each badge stood,
  // and nothing anywhere saying where the pictures belonged.
  const oldText = 'Here is the board [Image: board.png] and here is the chat [Image: chat.png] beside it';
  // And how it writes it now: his words only, with the place on the picture.
  const newText = 'Here is the board  and here is the chat  beside it';
  const text = before ? oldText : newText;
  const board = { mime: 'image/png', dataUrl: PICTURE, alt: 'board.png', ...(before ? {} : { at: newText.indexOf(' and here') + 1 }) };
  const chat = { mime: 'image/png', dataUrl: PICTURE, alt: 'chat.png', ...(before ? {} : { at: newText.indexOf(' beside it') + 1 }) };

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'sent', role: 'user', composedHere: true },
    { ...base, seq: 3, type: 'image', messageId: 'sent', image: board },
    { ...base, seq: 4, type: 'image', messageId: 'sent', image: chat },
    { ...base, seq: 5, type: 'text.delta', messageId: 'sent', text },
    { ...base, seq: 6, type: 'message.completed', messageId: 'sent' },
    { ...base, seq: 7, type: 'session.state', state: 'idle', label: 'Ready' },
  ] as WbpEvent[];
  const snapshot = foldAll(events);

  await page.addInitScript(({ chat: name, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') === name) setTimeout(() => this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ tag: 'chat.snapshot', scope: name, data: JSON.stringify(view) }),
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'claude', title: 'A badge in place', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'A badge in place', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Badge in place fixture', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'A badge in place' }).getByTestId('row-name').click();
    await expect(page.getByText('Here is the board')).toBeVisible();

    const message = page.locator('[data-testid="user-message"]');
    await expect(message.locator('[data-testid="message-image"]')).toHaveCount(2);

    if (before) {
      // Both pictures above the words, and the app's prose left in the sentence.
      await expect(message.locator('[data-testid="picture-grid"]')).toHaveCount(1);
      await expect(message).toContainText('[Image: board.png]');
    } else {
      // One grid per picture, each drawn where its badge sat, and not a bracket
      // anywhere in what he wrote.
      await expect(message.locator('[data-testid="picture-grid"]')).toHaveCount(2);
      await expect(message).not.toContainText('[Image:');

      // Proven by position, not just by count: the first picture sits below the
      // words that came before it and above the words that came after.
      const words = await message.locator('p').first().boundingBox();
      const first = await message.locator('[data-testid="message-image"]').first().boundingBox();
      const rest = await message.locator('p').nth(1).boundingBox();
      expect(words!.y, 'the first picture is not below the words it followed').toBeLessThan(first!.y);
      expect(first!.y, 'the first picture is not above the words it preceded').toBeLessThan(rest!.y);
    }

    await page.screenshot({
      path: process.env.BADGE_IN_PLACE_SCREENSHOT || 'tests/results/bw-oamr-2-after.png',
      fullPage: false,
    });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
