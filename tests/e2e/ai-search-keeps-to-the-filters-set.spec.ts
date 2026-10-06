import { expect, test } from '@playwright/test';

import { aChatSomebodyElseIsIn, aProjectOfItsOwn, openChatTab } from './fixture-held';

/**
 * The AI search takes the same filters as a search in words, and the agent is
 * held to them (bw-v10zq.1). The project the panel opened on is carried into
 * the AI box; changing it with the control sends the search to the other
 * project, although the agent's own query names none.
 *
 * The agent is tests/e2e/fixtures/fake-search-agent.mjs, started in place of
 * Claude: run with CLAUDE_PATH pointing at it. It searches with the question's
 * words alone, so only the server can have put the project there.
 */
test('an AI search keeps to the filters set in its box', async ({ page, request }) => {
  test.setTimeout(180_000);
  const here = await aProjectOfItsOwn(request, 'filter-here');
  const there = await aProjectOfItsOwn(request, 'filter-there');
  const word = `cobalt${Date.now()}`;
  const near = aChatSomebodyElseIsIn(here.path, 'Tune the importer');
  near.says(`We switched the ${word} cache off and the importer stopped stalling.`);
  // Said more here, so a search the server did not hold would find this chat first.
  near.says(`With the ${word} cache off, the ${word} warnings are gone too.`);
  const far = aChatSomebodyElseIsIn(there.path, 'Tune the exporter');
  far.says(`We switched the ${word} cache on and the exporter sped up.`);

  try {
    const chosen = await request.put('/api/settings/search', {
      data: { provider: 'claude', profile: null, model: null, effort: null, timeLimitSeconds: 60 },
    });
    expect(chosen.ok(), await chosen.text()).toBeTruthy();
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    // A chat that is only a terminal record is known once its project's chat tab lists it.
    await openChatTab(page, there);
    await expect(page.locator(`[data-testid="restore-row"][data-external-id="${far.id}"]`)).toBeVisible({ timeout: 60_000 });
    await openChatTab(page, here);
    await expect(page.locator(`[data-testid="restore-row"][data-external-id="${near.id}"]`)).toBeVisible({ timeout: 60_000 });
    // The index reads records on its own beat.
    await expect
      .poll(
        async () => {
          const found = await request.get(`/api/workbench/search/chats?q=${word}`);
          return ((await found.json()) as { chats: unknown[] }).chats.length;
        },
        { timeout: 90_000, intervals: [1_000] },
      )
      .toBe(2);

    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('search-input')).toHaveValue(`project:${here.name} `);
    await page.getByTestId('search-mode-ai').click();
    // The filter came across, with its control, and the order did not.
    await expect(page.getByTestId('ai-search-input')).toHaveValue(`project:${here.name} `);
    await expect(page.getByTestId('search-filter-project')).toHaveAttribute('data-value', here.name);
    await expect(page.getByTestId('search-scope-title')).toBeVisible();
    await expect(page.getByTestId('search-sort')).toHaveCount(0);

    await page.getByTestId('search-filter-project').click();
    await page.locator(`[data-testid="search-filter-project-choice"][data-value="${there.name}"]`).click();
    await expect(page.getByTestId('ai-search-input')).toHaveValue(`project:${there.name} `);
    await page.getByTestId('ai-search-input').pressSequentially(word);
    await page.screenshot({ path: 'tests/results/ai-search-filters.png' });
    await page.getByTestId('ai-search-ask').click();

    const found = page.getByTestId('ai-search-chat');
    await expect(found).toHaveCount(1, { timeout: 60_000 });
    await expect(found).toContainText(/Tune the exporter/i);
    // The agent searched its own words; the project was the server's to add.
    await expect(page.getByTestId('ai-search-step').filter({ hasText: `Searched ${word}` })).toBeVisible();
    await expect(page.getByTestId('ai-search-failed')).toHaveCount(0);
    await page.screenshot({ path: 'tests/results/ai-search-filtered.png' });

    // Back in words, the filter set in the AI box is the search's.
    await page.getByTestId('search-mode-words').click();
    await expect(page.getByTestId('search-input')).toHaveValue(`project:${there.name} `);
  } finally {
    near.forget();
    far.forget();
    await here.remove();
    await there.remove();
  }
});
