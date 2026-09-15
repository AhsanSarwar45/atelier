import { expect, test } from '@playwright/test';

import { aChatSomebodyElseIsIn, aProjectOfItsOwn, openChatTab } from './fixture-held';

/**
 * Asked in words, the AI search runs the agent chosen in Settings, shows what
 * it is doing, and lists the chat it found with its reason — and not the chat
 * it made up (bw-21a2.5).
 *
 * The agent is tests/e2e/fixtures/fake-search-agent.mjs, started in place of
 * Claude: run with CLAUDE_PATH pointing at it. It searches through the same
 * MCP tools a real agent is given.
 */
test('an AI search lists the real chat it found and drops the one it made up', async ({ page, request }) => {
  test.setTimeout(180_000);
  const project = await aProjectOfItsOwn(request, 'ask');
  const word = `cobalt${Date.now()}`;
  const chat = aChatSomebodyElseIsIn(project.path, 'Tune the importer');
  chat.says(`We switched the ${word} cache off and the importer stopped stalling.`);

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
    await openChatTab(page, project);
    // A chat that is only a terminal record is known once the chat tab lists it.
    await expect(page.locator(`[data-testid="restore-row"][data-external-id="${chat.id}"]`)).toBeVisible({ timeout: 60_000 });
    // The index reads records on its own beat.
    await expect
      .poll(
        async () => {
          const found = await request.get(`/api/workbench/search/chats?q=${word}`);
          return ((await found.json()) as { chats: unknown[] }).chats.length;
        },
        { timeout: 90_000, intervals: [1_000] },
      )
      .toBe(1);

    await page.keyboard.press('Control+k');
    await page.getByTestId('search-mode-ai').click();
    await expect(page.getByTestId('search-mode-ai')).toHaveAttribute('data-state', 'active');
    await page.getByTestId('ai-search-input').fill(word);
    await page.getByTestId('ai-search-ask').click();

    const found = page.getByTestId('ai-search-chat');
    await expect(found).toHaveCount(1, { timeout: 60_000 });
    await expect(found.getByTestId('ai-search-reason')).toHaveText(`It is where ${word} came up`);
    // A generated title is capitalised.
    await expect(found).toContainText(/Tune the importer/i);
    await expect(page.locator('[data-session-id="a-chat-nobody-had"]')).toHaveCount(0);
    await expect(page.getByTestId('ai-search-step').filter({ hasText: `Searched ${word}` })).toBeVisible();
    await expect(page.getByTestId('ai-search-step').filter({ hasText: /Read Tune the importer/i })).toBeVisible();
    await expect(page.getByTestId('ai-search-failed')).toHaveCount(0);
    await expect(page.getByTestId('ai-search-stop')).toHaveCount(0);
    await page.screenshot({ path: 'tests/results/ai-search-found.png' });

    await found.click();
    await expect(page).toHaveURL(/[?&]chat=/);
  } finally {
    chat.forget();
    await project.remove();
  }
});
