import { expect, test } from '@playwright/test';

import { aChatSomebodyElseIsIn, aProjectOfItsOwn, openChatTab } from './fixture-held';

/**
 * A search can be aimed at titles alone, and a match opens the chat at the
 * message it was found in — however far back that is (bw-21a2.3).
 *
 * Two chats say the same word; only one has it in its title, so `title:` must
 * leave the other out. The word searched for next was said three hundred
 * replies before the end, well beyond the page a chat opens with, and the
 * jump must still land on it with it marked.
 *
 * Needs the shared marker harness; see fixture-held.ts for BEADS_E2E_MARKERS.
 */
test('a title-only search finds only the titled chat, and a match opens the chat at it', async ({ page, request }) => {
  test.setTimeout(240_000);
  const project = await aProjectOfItsOwn(request, 'find');
  const stamp = Date.now();
  const titled = `umber${stamp}`;
  const deep = `vermilion${stamp}`;
  const named = aChatSomebodyElseIsIn(project.path, `Plan the ${titled} rollout`);
  named.says('Early answer, before the long middle.');
  named.says(`The ${deep} switch has to be flipped before the migration.`);
  for (let turn = 1; turn <= 300; turn += 1) named.says(`answer number ${turn}, with enough words in it to be a real reply`);
  const other = aChatSomebodyElseIsIn(project.path, 'Something else entirely');
  other.says(`Only mentions ${titled} in passing.`);

  try {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    await openChatTab(page, project);
    await expect(page.locator(`[data-testid="restore-row"][data-external-id="${named.id}"]`)).toBeVisible({ timeout: 60_000 });

    // Ctrl+K opens it from anywhere on the screen.
    await page.keyboard.press('Control+k');
    const box = page.getByTestId('search-input');
    await expect(box).toBeFocused();

    // The index reads records on its own beat, so ask until it has come round.
    await expect
      .poll(
        async () => {
          // Emptied first: the same words typed again are no change, and ask
          // nothing new of an index that has caught up since.
          await box.fill('');
          await box.fill(`${titled} `);
          await page.waitForTimeout(1_000);
          return page.getByTestId('search-chat').count();
        },
        { timeout: 90_000, intervals: [1_000] },
      )
      .toBe(2);

    // The Title control writes the key, and the other chat drops out.
    await page.getByTestId('search-scope-title').click();
    await expect(box).toHaveValue(`in:title ${titled} `);
    await expect(page.getByTestId('search-scope-title')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('search-chat')).toHaveCount(1);
    await expect(page.getByTestId('search-chat-title').getByTestId('search-mark')).toHaveText(new RegExp(`^${titled}$`, 'i'));
    await page.screenshot({ path: 'tests/results/search-title-only.png' });

    // Typed by hand, the key does the same.
    await box.fill(`title:${titled} `);
    await expect(page.getByTestId('search-chat')).toHaveCount(1);

    await box.fill(`${deep} `);
    const hit = page.getByTestId('search-hit').filter({ hasText: 'switch has to be flipped' });
    await expect(hit).toHaveCount(1);
    await box.press('ArrowDown');
    await box.press('Enter');

    await expect(page).toHaveURL(/[?&]message=/);
    // Seven pages back, in view, and marked as the place the search found.
    const sentence = page.getByTestId('virtual-transcript').getByText(`${deep} switch has to be flipped`);
    await expect(sentence).toBeInViewport({ timeout: 60_000 });
    await expect(page.locator('[data-found]')).toContainText(`${deep} switch has to be flipped`);
    await page.screenshot({ path: 'tests/results/search-opened-at-the-match.png' });
  } finally {
    named.forget();
    other.forget();
    await project.remove();
  }
});
