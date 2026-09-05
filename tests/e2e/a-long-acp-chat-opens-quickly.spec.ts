import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * A long chat replayed over ACP opens in a readable time.
 *
 * The complaint this run stands against: external chats "take ages to load".
 * The file-backed readers are proved elsewhere; this is the ACP path, which is
 * the one the app is supposed to prefer — a whole conversation arriving as a
 * stream of `session/update` notifications during one `session/load`.
 *
 * Length is the whole point. A cost that is quadratic in the number of updates
 * — a normalizer that rescans what it has already seen, a write per event that
 * reopens a transaction — is invisible on the two-line chats the other ACP run
 * uses, and is the entire complaint on a real one. A thousand turns is a
 * normal working day's chat.
 *
 * Run it against the scripted agent in tests/fixtures/acp-adapters:
 *
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" \
 *     scripts/workbench-e2e.sh tests/e2e/a-long-acp-chat-opens-quickly.spec.ts
 */
const FIXTURE = join(__dirname, '..', '.workbench-run-acp-long');
const LONG = { id: 'acp-session-long', title: 'A very long chat over ACP', last: 'and that is the last answer over ACP, 1000' };
const BUDGET_MS = 10_000;

test('a thousand-turn chat replayed over ACP opens without the reader waiting on it', async ({ page, request }) => {
  test.setTimeout(120_000);
  test.skip(
    !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'),
    'needs the scripted ACP agent; see the comment above',
  );
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'ACP long fixture', path: FIXTURE, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);

    const row = page.locator(`[data-testid="restore-row"][data-external-id="${LONG.id}"]`);
    await expect(row, 'the long ACP chat was not offered').toBeVisible({ timeout: 30_000 });
    await expect(row.getByTestId('row-name')).toHaveText(LONG.title);

    // Cold: nothing of this chat is in our own store, so this open is the one
    // that goes to the agent and reads the whole conversation off the wire.
    const clicked = Date.now();
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('transcript').getByText(LONG.last)).toBeVisible({ timeout: 60_000 });
    const cold = Date.now() - clicked;

    // And again, which must not go to the agent at all: a chat replayed once
    // is this app's own from then on.
    await page.reload();
    await expect(row).toBeVisible({ timeout: 30_000 });
    const reopened = Date.now();
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('transcript').getByText(LONG.last)).toBeVisible({ timeout: 60_000 });
    const warm = Date.now() - reopened;

    expect(cold, `a cold ACP load of a thousand turns took ${cold}ms`).toBeLessThan(BUDGET_MS);
    expect(warm, `reopening a chat already replayed took ${warm}ms`).toBeLessThan(2_000);
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
