import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The list lights the chat being started, from the click (bw-akk9.1).
 *
 * The fault: the app learned what the new chat was called from the launch's
 * answer, and the launch answers when the agent is up — a second or two later,
 * and the whole of that second the address still named the chat he had left. So
 * did the list, which reads the address and nothing else: the new chat's row
 * appears within a frame of the click, and it sat there unlit under a highlight
 * belonging to the old chat until the launch finished.
 *
 * The chat is named by the screen now, so the address is the new chat from the
 * click and the row the list lights is the right one all along.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-list-lights-the-chat-being-started.spec.ts
 */

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** Starting an agent is a process launch. */
const HELLO_MS = 120_000;

/**
 * How long the second launch's ANSWER is held back. The server still does the
 * work — it makes the chat, and the row appears — the screen is just told late,
 * which is what a real launch does to it. Against the stub that gap is a few
 * hundred milliseconds, too narrow for a case to stand in.
 */
const HELD_MS = 4_000;

/** How the list says which row is the open chat. */
const LIT = '.bg-accent';

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

  test('is the chat being started, not the one it replaced', async ({ page, request }) => {
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
    const old = page.locator(`[data-testid="restore-row"][data-row-key="${first}"]`);
    await expect(old).toHaveClass(/bg-accent/);

    await page.route('**/api/workbench/command', async (route) => {
      const body = route.request().postDataJSON() as { type?: string } | null;
      if (body?.type !== 'session.start') return route.continue();
      const answer = await route.fetch();
      await new Promise((done) => setTimeout(done, HELD_MS));
      await route.fulfill({ response: answer });
    });

    await page.getByTestId('new-chat-tool').click();
    await page.getByTestId('new-chat-provider-dialog').getByRole('button', { name: 'Start chat' }).click();

    // A quarter of the hold in: the chat has been made and its row is in the
    // list, and nothing that follows can be the answer arriving. The picture is
    // taken before anything is asserted, so a tree with the fault in it still
    // leaves the picture that shows the fault.
    await page.waitForTimeout(HELD_MS / 4);
    await expect(page.getByTestId('chat-starting')).toContainText('Starting Claude chat…');
    await expect(page.getByTestId('new-chat-provider-dialog')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/bw-akk9-starting.png` });

    // The address is the new chat, and the lit row is the new chat's — the one
    // he left is dark, and it is the only other row there is.
    const second = new URL(page.url()).searchParams.get('chat') ?? '';
    expect(second).not.toBe(first);
    expect(second).not.toBe('');
    await expect(page.locator(`[data-testid="restore-row"][data-row-key="${second}"]`)).toHaveClass(/bg-accent/);
    await expect(old).not.toHaveClass(/bg-accent/);
    await expect(page.locator(`[data-testid="restore-row"]${LIT}`)).toHaveCount(1);

    // And the chat it opens on is that same chat, still the lit row.
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    expect(new URL(page.url()).searchParams.get('chat')).toBe(second);
    await expect(page.locator(`[data-testid="restore-row"][data-row-key="${second}"]`)).toHaveClass(/bg-accent/);
    await page.screenshot({ path: `${SHOTS}/bw-akk9-started.png` });
  });
});
