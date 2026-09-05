/**
 * A chat started from the app is ours from the first frame it is drawn
 * (bw-cwap).
 *
 * It was not: the box flashed the blue held-elsewhere line before the writing
 * box appeared, on every chat started from the app. The provider process the
 * app spawns writes its own marker as it starts, and the two-second hold beat
 * that landed before the server had written the process down as its own
 * published it as somebody else's; the browser then opened the chat against
 * that reading and drew the line until the next beat.
 *
 * Against a live provider, because the flash is made of real timing: a real
 * process writing a real marker while a real driver is still connecting. In
 * the page rather than by a fresh navigation, because a navigation reconnects
 * the stream and is handed a fresh reading — which is exactly the reading the
 * open-in-place path did not have.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const FIXTURE = join(__dirname, '..', '.workbench-run-new-chat-never-held');
const SHOTS = 'tests/results';
/** A live provider's first answer, generously. */
const HELLO_MS = 120_000;
/** Longer than the hold beat by a margin: the flash lasted until the next one. */
const WATCH_MS = 5_000;

test('a chat started from the app never draws the held-elsewhere line', async ({ page, request }) => {
  test.skip(process.env.BEADS_E2E_LIVE_PROVIDERS !== '1', 'needs a live provider: the flash is made of a real process starting');
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await request.post('/api/projects', {
    data: { name: 'new-chat-never-held', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  try {
    await page.goto(`/project?id=${project.id}&tab=chat`);
    // The stream must have spoken once before the chat is started, so the
    // reading the chat is opened against is a stale beat and not nothing.
    await page.getByTestId('new-chat-tool').click();
    await page.getByTestId('new-chat-provider-dialog').getByRole('button', { name: 'Start chat' }).click();
    await page.waitForURL((url) => Boolean(url.searchParams.get('chat')), { timeout: HELLO_MS });

    const held = page.getByTestId('held-elsewhere');
    const composer = page.getByTestId('composer');
    // Every frame from the open until well past the next beat: the line is
    // never drawn, and the box is what stands there.
    const until = Date.now() + WATCH_MS;
    let sawTheBox = false;
    while (Date.now() < until) {
      expect(await held.count(), 'the held-elsewhere line was drawn over a chat this app started').toBe(0);
      if (await composer.count()) sawTheBox = true;
      await page.waitForTimeout(50);
    }
    expect(sawTheBox, 'the writing box never appeared').toBe(true);
    await expect(composer).toBeVisible();
    await expect(composer).toBeEnabled();

    const frame = (await page.getByTestId('composer-frame').boundingBox())!;
    await page.screenshot({
      path: `${SHOTS}/a-new-chat-is-never-held-elsewhere.png`,
      clip: { x: frame.x - 8, y: frame.y - 8, width: frame.width + 16, height: frame.height + 16 },
    });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
