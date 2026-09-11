import { expect, test } from '@playwright/test';

import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

/**
 * A message he sent is drawn whether the picture came before the words or after
 * (bw-oamr.1).
 *
 * Attaching a picture and then typing put the composer's own `[Image: name]`
 * substitution at the head of the message text. The transcript worked out who
 * wrote a message by reading it — one of the shapes it matches on is the prefix
 * `[Image: ` — so an image-first message was filed as a line the kit had
 * written in his name, given the machine audience, and hidden by the default
 * filters. His words and his picture both disappeared, with nothing on screen
 * to say a message had been sent at all.
 *
 * Provenance is now recorded rather than guessed: `record_user_for_transport`
 * stamps `composedHere` on every message this app's own composer sends, and the
 * transcript only falls back to reading the words for a chat it merely follows.
 *
 * Both orders are in one chat, because the whole point is that the order stops
 * mattering. Set OPENS_WITH_PICTURE_BEFORE to seed the same two messages with
 * no provenance on them, which is exactly the state every message was in before
 * this change: that run asserts the image-first one is missing, and is how the
 * "before" half of the evidence is taken.
 */

const CHAT = 'opens-with-a-picture-fixture';

// A 160x100 checkerboard. Big enough to be seen in the evidence: a picture
// too small to make out proves the count and nothing a reader can check.
const PICTURE =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAAAAAAk3WRTAAAAbklEQVR42u3ZMQ0AMAwDsMIp' +
  'fyhDNAK5u6ly7hx+o9QJ6ZBXvQIEBAQEBAQEBAQEXA38CZN6gICAgICAgICAgIC7gVYdICAg' +
  'ICAgICAgIKCfxOwEBAQEBAQEBAQE9JNYdYCAgICAgICAgICA470LgSCGQy0Mr04AAAAASUVO' +
  'RK5CYII=';

const IMAGE_FIRST = 'the attachment badges do not show in the sent message';
const WORDS_FIRST = 'and here is the same thing the other way round';

test('a message whose picture comes first is still drawn as his', async ({ page, request }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  const run = join(process.cwd(), 'tests', '.workbench-run-opens-with-a-picture');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));

  // The composer's own substitution: the marker is replaced where it stood, so
  // a picture attached before typing leaves `[Image: ...]` at the head.
  const opensWithPicture = `[Image: shot.png] ${IMAGE_FIRST}`;
  const endsWithPicture = `${WORDS_FIRST} [Image: shot.png]`;
  const shot = { mime: 'image/png', dataUrl: PICTURE, alt: 'shot.png' };

  // Before this change nothing carried provenance, so the "before" run simply
  // leaves it off — the same code, reading the same words, with nothing else to
  // go on. That is precisely the state the bug was reported in.
  const his = process.env.OPENS_WITH_PICTURE_BEFORE ? {} : { composedHere: true };

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'first', role: 'user', ...his },
    { ...base, seq: 3, type: 'image', messageId: 'first', image: shot },
    { ...base, seq: 4, type: 'text.delta', messageId: 'first', text: opensWithPicture },
    { ...base, seq: 5, type: 'message.completed', messageId: 'first' },
    { ...base, seq: 6, type: 'message.started', messageId: 'reply', role: 'assistant' },
    { ...base, seq: 7, type: 'text.delta', messageId: 'reply', text: 'Looking at it now.' },
    { ...base, seq: 8, type: 'message.completed', messageId: 'reply' },
    { ...base, seq: 9, type: 'message.started', messageId: 'second', role: 'user', ...his },
    { ...base, seq: 10, type: 'image', messageId: 'second', image: shot },
    { ...base, seq: 11, type: 'text.delta', messageId: 'second', text: endsWithPicture },
    { ...base, seq: 12, type: 'message.completed', messageId: 'second' },
    { ...base, seq: 13, type: 'session.state', state: 'idle', label: 'Ready' },
  ] as WbpEvent[];
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'claude', title: 'A picture first', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'A picture first', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Opens with a picture fixture', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'A picture first' }).getByTestId('row-name').click();

    // The words-last message is the control: it was never at risk, and waiting
    // on it means the transcript has finished drawing before anything is judged
    // missing. Without it a "before" frame could pass by being early.
    await expect(page.getByText(WORDS_FIRST)).toBeVisible();

    const transcript = page.locator('[data-testid="transcript"]');
    if (process.env.OPENS_WITH_PICTURE_BEFORE) {
      // The bug, held still: his words and his picture are both gone, and only
      // the one whose picture came last survived.
      await expect(page.getByText(IMAGE_FIRST)).toHaveCount(0);
      await expect(transcript.locator('[data-testid="message-image"]')).toHaveCount(1);
    } else {
      await expect(page.getByText(IMAGE_FIRST)).toBeVisible();
      // Both messages keep their picture, whichever side of the words it sat.
      await expect(transcript.locator('[data-testid="message-image"]')).toHaveCount(2);
    }

    await page.screenshot({
      path: process.env.OPENS_WITH_PICTURE_SCREENSHOT || 'tests/results/bw-oamr-1-after.png',
      fullPage: false,
    });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
