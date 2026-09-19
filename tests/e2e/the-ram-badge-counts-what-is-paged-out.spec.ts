import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { PARENT_CARD, discardFixture, makeFixtureProject } from './fixture-board';
import { writeChatWithHelper } from './fixture-record';

/**
 * The RAM badge counts what the app has paged out (bw-c4i2.2).
 *
 * The badge read `Pss:` out of each process's `smaps_rollup` and stopped there,
 * so every page the kernel had pushed to swap was memory the app cost the
 * machine that nobody was charged for. The owner caught it from the outside: a
 * system monitor read 18.9 GiB used while the chip read 4.1 GB, and the app's
 * own tree turned out to be holding 3.23 GiB resident against 3.08 GiB
 * swapped — the chip was reporting a little over half of what the app cost.
 *
 * Two questions, because one machine cannot be made to answer both:
 *
 *  * against the real server on this instance, the chip draws a figure and the
 *    popover opens on it — route, reader and badge agree end to end, whatever
 *    this machine's swap happens to be;
 *  * against a report that does have pages paged out, the popover splits the
 *    total into what is resident and what is swapped, and the halves add back
 *    up to the figure on the chip. A fresh instance on an unpressured machine
 *    has nothing in swap, so the split has no other way to be seen.
 *
 * And the third, which is why the split is conditional at all: a report with
 * nothing swapped must not draw a line saying so.
 *
 * The badge lives on the chat's own status line, so a chat has to be open for
 * it to be drawn at all. It is read off a written record rather than a chat
 * this app drove: what is being proved is the badge, and launching a provider
 * to see it would make the case wait on somebody else's network.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-ram-badge-counts-what-is-paged-out.spec.ts
 */

/** One per case: the cases run in parallel and must not share a fixture. */
const runDir = (): string => join(__dirname, '..', `.workbench-run-ram-badge-${randomUUID()}`);
const SHOTS = join(process.cwd(), 'tests', 'results', 'the-ram-badge-counts-what-is-paged-out');
const OPEN_MS = 60_000;

/** A report shaped like the server's, with about half the total paged out. */
const UNDER_PRESSURE = {
  totalBytes: 6.32 * 1024 ** 3,
  swapBytes: 3.08 * 1024 ** 3,
  metric: 'pssWithSwap',
  processCount: 99,
  chats: [{ sessionId: 'chat-1', title: 'Fix the RAM badge', bytes: 1.2 * 1024 ** 3, processes: 4 }],
  processDetails: [
    { pid: 1615416, parentPid: null, name: 'atelier', bytes: 260 * 1024 ** 2, swapBytes: 7 * 1024 ** 2, sessionId: null, chatTitle: null, role: 'app', killable: false, startTime: 1 },
    { pid: 3666404, parentPid: 1615416, name: 'claude', bytes: 278 * 1024 ** 2, swapBytes: 42 * 1024 ** 2, sessionId: 'chat-1', chatTitle: 'Fix the RAM badge', role: 'provider', killable: false, startTime: 2 },
    { pid: 3666500, parentPid: 3666404, name: 'cargo', bytes: 190 * 1024 ** 2, swapBytes: 31 * 1024 ** 2, sessionId: 'chat-1', chatTitle: 'Fix the RAM badge', role: 'subprocess', killable: true, startTime: 3 },
  ],
};

// Reading a chat back off the disk is a page load, a list and a transcript.
test.setTimeout(120_000);

async function projectAt(request: APIRequestContext, name: string, path: string): Promise<{ id: string }> {
  const made = await request.post('/api/projects', { data: { name, path } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

/**
 * A project with one written chat, opened, with the status line on screen.
 * Returns the fixture directory for the case to discard when it is done.
 */
async function aChatOnScreen(page: Page, request: APIRequestContext): Promise<string> {
  const run = runDir();
  const path = join(run, 'project');
  mkdirSync(run, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  makeFixtureProject(path, join(run, 'reports'));
  const project = await projectAt(request, `workbench-ram-badge-${randomUUID().slice(0, 8)}`, path);
  const written = writeChatWithHelper({ cwd: path, sessionId: randomUUID(), card: PARENT_CARD });

  await page.goto(`/project?id=${project.id}&tab=chat`);
  const row = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
  await row.waitFor({ timeout: OPEN_MS });
  await row.getByTestId('row-name').click();
  await page.getByTestId('chat-status-line').waitFor({ timeout: OPEN_MS });
  return run;
}

test('the badge draws a real figure and its popover opens on it', async ({ page, request }) => {
  const run = await aChatOnScreen(page, request);
  try {
    const badge = page.getByTestId('memory-badge');
    await expect(badge).toBeVisible({ timeout: OPEN_MS });
    // A figure, not an empty chip: the route answered and the reader parsed it.
    await expect(badge).toHaveText(/\d+(\.\d+)?\s(KB|MB|GB)/);

    await badge.click();
    const popup = page.getByTestId('memory-popup');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText('resident and swapped');
    await expect(page.getByTestId('memory-process-row').first()).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'live.png') });
  } finally {
    discardFixture(run);
  }
});

test('a total that includes paged-out memory says how much of it is paged out', async ({ page, request }) => {
  await page.route('**/api/workbench/memory', route => route.fulfill({ json: UNDER_PRESSURE }));
  const run = await aChatOnScreen(page, request);
  try {
    const badge = page.getByTestId('memory-badge');
    await expect(badge).toBeVisible({ timeout: OPEN_MS });
    // 6.3 GB is the whole cost, not the 3.2 GB that is merely resident.
    await expect(badge).toHaveText('6.3 GB');

    await badge.click();
    const split = page.getByTestId('memory-swap-line');
    await expect(split).toBeVisible();
    await expect(split).toContainText('In RAM 3.2 GB');
    await expect(split).toContainText('Swapped 3.1 GB');
    await page.screenshot({ path: join(SHOTS, 'under-pressure.png') });
  } finally {
    discardFixture(run);
  }
});

test('a report with nothing paged out draws no swap line', async ({ page, request }) => {
  const nothingSwapped = {
    ...UNDER_PRESSURE,
    swapBytes: 0,
    processDetails: UNDER_PRESSURE.processDetails.map(row => ({ ...row, swapBytes: 0 })),
  };
  await page.route('**/api/workbench/memory', route => route.fulfill({ json: nothingSwapped }));
  const run = await aChatOnScreen(page, request);
  try {
    const badge = page.getByTestId('memory-badge');
    await expect(badge).toBeVisible({ timeout: OPEN_MS });
    await badge.click();
    await expect(page.getByTestId('memory-popup')).toBeVisible();
    await expect(page.getByTestId('memory-swap-line')).toHaveCount(0);
  } finally {
    discardFixture(run);
  }
});
