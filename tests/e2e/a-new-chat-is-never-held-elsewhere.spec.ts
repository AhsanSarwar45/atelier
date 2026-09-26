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

/**
 * Stopping a chat from the app never draws it as somebody else's (bw-4retm).
 *
 * Stop kills the provider with SIGKILL, so it cannot delete its marker, and for
 * a moment its process is still in the table while it exits. What the server
 * reads ownership from — the process's environment and its group leader — goes
 * first, so a hold beat in that moment filed the dying process as another
 * program's, and the chat flashed the external badge and the held line.
 */
test('a chat stopped from the app never draws the held-elsewhere line', async ({ page, request }) => {
  test.skip(process.env.BEADS_E2E_LIVE_PROVIDERS !== '1', 'needs a live provider: the flash is made of a real process dying');
  test.setTimeout(240_000);
  const fixture = `${FIXTURE}-stop`;
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await request.post('/api/projects', {
    data: { name: 'stopped-chat-never-held', path: fixture, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };

  try {
    const started = await request.post('/api/workbench/command', {
      data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude', permissionMode: 'bypassPermissions' },
    });
    expect(started.ok(), await started.text()).toBe(true);
    const sessionId = ((await started.json()) as { id: string }).id;
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
    const composer = page.getByTestId('composer');
    await composer.waitFor({ timeout: HELLO_MS });
    await composer.fill('Run the shell command `sleep 90` with your Bash tool, then say done.');
    await composer.press('Enter');
    await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: HELLO_MS });
    // Well into the turn, so the provider is mid-command when it is killed.
    await page.waitForTimeout(8_000);

    await page.getByTestId('stop-button').click();
    const until = Date.now() + WATCH_MS;
    while (Date.now() < until) {
      expect(await page.getByTestId('held-elsewhere').count(), 'a stopped chat was drawn as held elsewhere').toBe(0);
      expect(await page.getByTestId('external-origin').count(), 'a stopped chat was badged as another program’s').toBe(0);
      await page.waitForTimeout(25);
    }
    await expect(page.getByTestId('stop-button')).toHaveCount(0);
    await expect(composer).toBeEnabled();
    await page.screenshot({ path: `${SHOTS}/a-stopped-chat-is-never-held-elsewhere.png` });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
