import { expect, test } from '@playwright/test';

import {
  aChatSomebodyElseIsIn,
  aProjectOfItsOwn,
  openChatTab,
} from './fixture-held';

/**
 * A long chat worked in outside this app opens in a readable time.
 *
 * The complaint this run stands against: external chats "take ages to load".
 * The manager's own chats are hundreds of turns long, and the run before this
 * one proved a short chat opens quickly, which is not the same claim at all —
 * a cost that is linear in the record is invisible on a chat with one line in
 * it and is the whole of the complaint on a chat with a thousand.
 *
 * What is measured is what he is waiting for: the click, and the LAST thing
 * said in the chat on screen. Not the first message, which a reader cannot
 * tell from an empty transcript scrolled to the top.
 *
 * Needs the shared marker harness; see fixture-held.ts for BEADS_E2E_MARKERS.
 */
const TURNS = 2_000;
const BUDGET_MS = 6_000;

test('a chat of two thousand turns opens without the reader waiting on it', async ({ page, request }) => {
  test.setTimeout(180_000);
  const project = await aProjectOfItsOwn(request, 'long');
  const chat = aChatSomebodyElseIsIn(project.path, 'Start of a long conversation');
  const last = `and that is the last answer, ${TURNS}`;
  for (let turn = 1; turn <= TURNS; turn += 1) {
    chat.says(turn === TURNS ? last : `answer number ${turn}, with enough words in it to be a real reply`);
  }

  try {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    await openChatTab(page, project);

    const row = page.locator(`[data-testid="restore-row"][data-external-id="${chat.id}"]`);
    await expect(row, 'the long chat was not offered').toBeVisible({ timeout: 60_000 });

    // Cold: nothing of this chat has been read into our own store yet, so this
    // is the open that goes to the provider for the whole record.
    const clicked = Date.now();
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('transcript').getByText(last)).toBeVisible({ timeout: 60_000 });
    const cold = Date.now() - clicked;

    // And again, which is the open that must not go anywhere: a chat read once
    // is this app's own from then on.
    await page.getByTestId('restore-row').first().waitFor();
    await page.reload();
    await expect(row).toBeVisible({ timeout: 60_000 });
    const reopened = Date.now();
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('transcript').getByText(last)).toBeVisible({ timeout: 60_000 });
    const warm = Date.now() - reopened;

    expect(cold, `a cold open of ${TURNS} turns took ${cold}ms`).toBeLessThan(BUDGET_MS);
    expect(warm, `reopening a chat already read took ${warm}ms`).toBeLessThan(2_000);
  } finally {
    chat.forget();
    await project.remove();
  }
});
