import { expect, test } from '@playwright/test';

import {
  aChatSomebodyElseIsIn,
  aProjectOfItsOwn,
  claimConversation,
  openChatTab,
} from './fixture-held';

/**
 * A chat somebody else is working in still says so after the screen is redrawn.
 *
 * The complaint this run stands against: external chats "randomly show status
 * as idle in a lot of situations". The suspect is the fast half of the restore
 * — the durable rows drawn before provider discovery finishes, which are sent
 * with the process table deliberately left off their critical path. Every row
 * in that response claims nobody is working in it, which is not "we have not
 * looked yet" but a positive "no", and it is what the reader sees first on
 * every reload, focus and project switch (bw-t26l.22).
 *
 * The chat here is one this app has already opened, because that is the case
 * the manager hits: he reads a chat, goes away, the terminal carries on, and
 * the row he comes back to reads Ready.
 *
 * Needs the shared marker harness; see fixture-held.ts for BEADS_E2E_MARKERS.
 */
test('a chat another program is working in does not read idle when the list is redrawn', async ({ page, request }) => {
  test.setTimeout(180_000);
  const project = await aProjectOfItsOwn(request, 'held');
  const chat = aChatSomebodyElseIsIn(project.path, 'Look at the routing on the chat tab');
  const release = claimConversation(chat.id, { status: 'busy' });
  const row = page.locator(`[data-testid="restore-row"][data-external-id="${chat.id}"]`);

  try {
    // The page's project list leaves test projects out, and this run's project
    // is one. Ask for them, the way the other runs that make their own do.
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    await openChatTab(page, project);
    await expect(row, 'the chat being worked in was not offered').toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveAttribute('data-running', 'yes', { timeout: 30_000 });

    // Read it once, so the row is one of ours from here on — it has a local
    // session behind it, and its state in our store is "asleep", because our
    // driver is not the one working in it.
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('held-elsewhere')).toBeVisible({ timeout: 30_000 });

    // Now redraw everything. Nothing about the chat has changed: the same
    // program is still in it, and the marker on disk still says so.
    await page.reload();
    await expect(row, 'the chat was not offered after the redraw').toBeVisible({ timeout: 30_000 });

    // Not "it is right in the end" — never wrong in between. A row that reads
    // Ready for a second and corrects itself has already told the reader the
    // chat is his to take up, and he is a keystroke into taking it.
    const wrong: string[] = [];
    const until = Date.now() + 4_000;
    while (Date.now() < until) {
      const said = await row.getAttribute('data-running');
      if (said !== 'yes') wrong.push(said ?? 'missing');
      await page.waitForTimeout(100);
    }
    expect(wrong, `the row said nobody was working in it ${wrong.length} times after the redraw`).toEqual([]);

    // And the half of the answer the screen is drawn from first, asked
    // directly. The screen survives above because the live feed reaches it
    // before the reader can look; that is a race this run happens to win on
    // this machine, and it is not what the row is standing on. What it stands
    // on is the response: a chat somebody is working in must not come back
    // from it saying nobody is.
    const fast = await page.evaluate(async (id: string) => {
      const project = new URL(location.href).searchParams.get('id')!;
      const q = new URLSearchParams({ project, path: '', local: '1' });
      const rows = await (await fetch(`/api/workbench/restore?${q}`)).json();
      const mine = rows.find((r: { externalId?: string }) => r.externalId === id);
      return mine ? { runningElsewhere: mine.runningElsewhere, held: mine.held } : null;
    }, chat.id);
    expect(fast, 'the fast list did not draw the chat at all').not.toBeNull();
    expect(fast!.runningElsewhere, 'the fast list said nobody is working in a chat somebody is working in').toBe(true);

    if (process.env.WORKBENCH_E2E_SHOT) {
      await page.locator('[data-testid="chat-sidebar"], aside').first()
        .screenshot({ path: process.env.WORKBENCH_E2E_SHOT });
    }
  } finally {
    release();
    await project.remove();
  }
});
