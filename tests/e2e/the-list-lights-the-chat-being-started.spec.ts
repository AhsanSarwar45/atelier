import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The list lights the chat being started, not the one it replaced (bw-mew1.1).
 *
 * The fault: the highlight was drawn against the address, and the address is
 * the last thing a launch changes. So for the second or two a launch takes,
 * the middle of the screen said "Starting Claude chat…" while the rail beside
 * it still pointed at the chat he had just left — and when the new row
 * appeared it appeared unlit, under a highlight belonging to another chat.
 *
 * Against a real launch, because the wait this is about is a real process
 * starting: a stubbed answer comes back too fast to have the fault at all.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-list-lights-the-chat-being-started.spec.ts
 */

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** Starting an agent is a process launch. */
const HELLO_MS = 120_000;

/** How long the second launch is held open, to stand in for a real one. */
const HELD_MS = 4_000;

/** A folder of its own, so this case never runs an agent in someone's work. */
const FIXTURE = join(__dirname, '..', '.workbench-run-lit-row');

/** The width this is looked at, with both columns open. */
const SCREEN = { width: 1440, height: 900 };

async function fixtureProject(request: APIRequestContext): Promise<{ id: string }> {
  const made = await request.post('/api/projects', {
    data: { name: 'lit-row', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

test.describe('the row the list lights', () => {
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

  test('leaves the chat being started from and lands on the new one', async ({ page, request }) => {
    const project = await fixtureProject(request);
    await page.goto(`/project?id=${project.id}&tab=chat`);

    // A chat to be sitting in when the second one is started. Without one the
    // fault has nothing to hold on to.
    await page.getByTestId('new-chat-tool').click();
    await page.getByTestId('new-chat-provider-dialog').getByRole('button', { name: 'Start chat' }).click();
    await page.waitForURL((url) => Boolean(url.searchParams.get('chat')), { timeout: HELLO_MS });
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    const first = new URL(page.url()).searchParams.get('chat') ?? '';
    expect(first).not.toBe('');
    await expect(page.locator(`[data-testid="restore-row"][data-row-key="${first}"]`)).toHaveAttribute('data-open', 'yes');

    // The launch this case is about is held open on purpose. A real one takes
    // a second or two and the fault lives in exactly that window; against the
    // stub the window is a frame or two wide, and a case that raced it would
    // pass on a tree with the fault still in it. Only the launch is held —
    // everything else the page asks for goes through untouched.
    await page.route('**/api/workbench/command', async (route) => {
      const body = route.request().postDataJSON() as { type?: string } | null;
      if (body?.type === 'session.start') await new Promise((done) => setTimeout(done, HELD_MS));
      await route.continue();
    });

    // Now start a second one from the rail, and look while it is still starting.
    await page.getByTestId('new-chat-tool').click();
    await page.getByTestId('new-chat-provider-dialog').getByRole('button', { name: 'Start chat' }).click();
    const starting = page.getByTestId('chat-starting');
    await expect(starting).toBeVisible();
    // The chooser has finished leaving, so the picture is of the screen and not
    // of a dialog halfway through its fade.
    await expect(page.getByTestId('new-chat-provider-dialog')).toHaveCount(0);

    // The chat he clicked away from goes dark at the click, before the address
    // has changed and while the middle of the screen is still a spinner. That
    // is the whole of the fault: it used to stay lit for the entire launch.
    // The picture is taken before the assertion, so a tree with the fault in it
    // still leaves the picture that shows the fault.
    // Well inside the held launch, so the answer arriving cannot be what makes
    // this true.
    const old = page.locator(`[data-testid="restore-row"][data-row-key="${first}"]`);
    await page.screenshot({ path: `${SHOTS}/bw-mew1-starting.png` });
    await expect(old).toHaveAttribute('data-open', 'no', { timeout: HELD_MS / 4 });
    await expect(starting).toBeVisible();

    // And the row that ends up lit is the chat the address arrives at.
    await page.waitForURL((url) => (url.searchParams.get('chat') ?? '') !== first, { timeout: HELLO_MS });
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    const second = new URL(page.url()).searchParams.get('chat') ?? '';
    await expect(
      page.locator(`[data-testid="restore-row"][data-open="yes"][data-row-key*="${second}"]`),
    ).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/bw-mew1-started.png` });
  });
});
