import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Starting a chat moves the reader to that chat at once (bw-l9cu.1).
 *
 * The fault: the click sent the command and waited for the server's answer
 * before opening anything, so for the second or two the launch takes the reader
 * was left on the screen he had just clicked away from — the row appeared in the
 * list beside him and nothing else happened. The centre of the screen now
 * belongs to the chat being started from the click onwards, with a spinner
 * standing where the transcript will stand.
 *
 * Against a real launch, because the wait this is about is a real process
 * starting: a stubbed answer comes back too fast to have the fault at all.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-starting-spinner.spec.ts
 */

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** Starting an agent is a process launch. */
const HELLO_MS = 120_000;

/** A folder of its own, so this case never runs an agent in someone's work. */
const FIXTURE = join(__dirname, '..', '.workbench-run-starting-spinner');

/** The width this is looked at, with both columns open. */
const SCREEN = { width: 1440, height: 900 };

async function fixtureProject(request: APIRequestContext): Promise<{ id: string }> {
  const made = await request.post('/api/projects', {
    data: { name: 'starting-spinner', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

test.describe('a chat being started', () => {
  test.use({ viewport: SCREEN });
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
  });

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('holds the middle of the screen with a spinner until the chat is there', async ({ page, request }) => {
    const project = await fixtureProject(request);
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    await page.getByTestId('new-chat-provider-dialog').getByRole('button', { name: 'Start chat' }).click();

    // The moment after the click: the chooser is gone, the screen he clicked
    // from is gone with it, and the address has not caught up yet.
    const starting = page.getByTestId('chat-starting');
    await expect(starting).toBeVisible();
    await expect(starting).toContainText('Starting Claude chat…');
    await expect(page.getByTestId('new-chat')).toHaveCount(0);
    // The chooser has finished leaving, so the picture is of the screen and
    // not of a dialog halfway through its fade.
    await expect(page.getByTestId('new-chat-provider-dialog')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/bw-l9cu-starting.png` });

    // And it gives way to the chat itself, not to the screen it replaced.
    await page.waitForURL((url) => Boolean(url.searchParams.get('chat')), { timeout: HELLO_MS });
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    await expect(page.getByTestId('chat-starting')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/bw-l9cu-started.png` });
  });
});
