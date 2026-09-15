import { expect, test } from '@playwright/test';

import {
  aChatSomebodyElseIsIn,
  aProjectOfItsOwn,
  openChatTab,
} from './fixture-held';

/**
 * A chat worked in from a terminal, and never opened here, is found by a word
 * said in it.
 *
 * Search used to read only the words this app had replayed into its own store,
 * so the chats begun in a terminal — most of the manager's — could not be found
 * at all, whatever they said (bw-21a2.1). The chat here is only ever a record
 * on disk: it is listed, never clicked, and the search must still find it.
 *
 * Needs the shared marker harness; see fixture-held.ts for BEADS_E2E_MARKERS.
 */
test('a word said in a terminal chat nobody opened here finds that chat', async ({ page, request }) => {
  test.setTimeout(180_000);
  const project = await aProjectOfItsOwn(request, 'search');
  const word = `saffron${Date.now()}`;
  const chat = aChatSomebodyElseIsIn(project.path, 'Why does the build fail on the loader');
  chat.says(`The ${word} flag was never passed to the loader.`);

  try {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    await openChatTab(page, project);
    const row = page.locator(`[data-testid="restore-row"][data-external-id="${chat.id}"]`);
    await expect(row, 'the terminal chat was not listed').toBeVisible({ timeout: 60_000 });

    await page.getByTestId('open-search').click();
    const box = page.getByTestId('search-input');
    // The index reads records on its own beat, so the word is asked for again
    // until that beat has come round — never longer than a minute.
    await expect
      .poll(
        async () => {
          await box.fill('');
          await box.fill(word);
          await page.waitForTimeout(1_500);
          return page.getByTestId('search-hit').count();
        },
        { timeout: 90_000, intervals: [1_000] },
      )
      .toBeGreaterThan(0);

    const hit = page.getByTestId('search-hit').first();
    await expect(hit.getByTestId('search-mark')).toHaveText(word);
    await expect(hit).toContainText('flag was never passed to the loader');
    await page.screenshot({ path: 'tests/results/a-terminal-chat-is-found-by-what-was-said.png' });
  } finally {
    chat.forget();
    await project.remove();
  }
});
