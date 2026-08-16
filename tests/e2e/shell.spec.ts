import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The shell: what never moves, and what is allowed to.
 *
 * Two bars sit above the work — the project's own, and the tabs with that
 * tab's tools. Nothing else. The window itself never scrolls; scrolling
 * happens inside the panes, and each pane scrolls alone.
 *
 * Needs an instance with a project that has cards and chats in it — the panes
 * have to have something to scroll. Pick one with BEADS_E2E_PROJECT, or the
 * first the instance lists.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
 *      npx playwright test tests/e2e/shell.spec.ts
 */

/** How far a pane is asked to scroll, and the least we accept as "it moved". */
const SCROLL_BY = 400;

async function projectId(request: APIRequestContext): Promise<string> {
  if (process.env.BEADS_E2E_PROJECT) return process.env.BEADS_E2E_PROJECT;
  // The screen may be served by a dev server while the data comes from the
  // instance next door, which is how a merge is watched live.
  const api = process.env.BEADS_E2E_BACKEND ?? '';
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as { id: string }[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return projects[0].id;
}

/** The window's own scroll: the page must have none of it. */
async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollHeight - el.clientHeight;
  });
}

/**
 * Scrolls a pane and reports how far it actually went.
 *
 * There are six board columns and only the full ones can scroll, so the one
 * with something in it is the one asked to move.
 */
async function scrollPane(page: Page, testId: string): Promise<number> {
  const panes = page.getByTestId(testId);
  await expect(panes.first(), `${testId} is not on the screen`).toBeVisible();
  return panes.evaluateAll((els, by) => {
    const pane = els.find((el) => el.scrollHeight > el.clientHeight);
    if (!pane) return 0;
    pane.scrollTop = by;
    return pane.scrollTop;
  }, SCROLL_BY);
}

test.describe('shell', () => {
  test('two bars on every tab, and the window itself never scrolls', async ({ page, request }) => {
    const id = await projectId(request);

    for (const tab of ['board', 'chat'] as const) {
      await page.goto(`/project?id=${id}&tab=${tab}`);
      await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });

      // Exactly two: the project bar, then the tabs and their tools.
      await expect(page.locator('[data-shell-bar]')).toHaveCount(2);
      await expect(page.getByTestId('project-bar')).toBeVisible();
      await expect(page.getByTestId('tab-bar')).toBeVisible();

      expect(await pageOverflow(page), `the ${tab} page scrolls as a whole`).toBeLessThanOrEqual(1);
    }
  });

  test('the bars hold their place while the board scrolls underneath them', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=board`);
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });

    const bars = page.locator('[data-shell-bar]');
    const before = await bars.first().boundingBox();

    const moved = await scrollPane(page, 'column-scroll');
    expect(moved, 'the board column did not scroll: this project has too few cards to prove anything').toBeGreaterThan(
      0,
    );

    expect(await bars.first().boundingBox(), 'a bar moved when the board scrolled').toEqual(before);
    expect(await pageOverflow(page), 'the window scrolled with the board').toBeLessThanOrEqual(1);
  });

  test('a long list of chats scrolls inside itself and moves nothing else', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });

    // The case only says anything about a project with more chats than fit. The
    // list draws a screenful and grows as it is pulled (docs/designs/app-shell.md
    // §1.6), so what is counted is enough to overflow, not the whole project.
    await expect
      .poll(() => page.getByTestId('restore-row').count(), { timeout: 60_000 })
      .toBeGreaterThan(20);

    const list = page.getByTestId('chat-list');
    const room = await list.evaluate((el) => ({ hidden: el.scrollHeight, shown: el.clientHeight }));
    expect(room.hidden, 'a list this long has to overflow its pane').toBeGreaterThan(room.shown * 1.5);

    const bars = page.locator('[data-shell-bar]');
    const before = await Promise.all([bars.first().boundingBox(), bars.last().boundingBox()]);
    const transcript = page.getByTestId('transcript');
    const conversationAt = (await transcript.count()) > 0 ? await transcript.evaluate((el) => el.scrollTop) : null;

    // All the way to the end, not one nudge: the bars have to hold at every
    // position, and the last screenful is where a broken pane runs out of room.
    const landed = await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(landed, 'the list did not scroll').toBeGreaterThan(room.shown);

    expect(await Promise.all([bars.first().boundingBox(), bars.last().boundingBox()]), 'a bar moved').toEqual(before);
    if (conversationAt !== null) {
      expect(await transcript.evaluate((el) => el.scrollTop), 'the conversation moved with the list').toBe(
        conversationAt,
      );
    }
    expect(await pageOverflow(page), 'the window scrolled with the list').toBeLessThanOrEqual(1);
  });

  test('the chat list scrolls without moving the conversation', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('chat-list')).toBeVisible({ timeout: 30_000 });
    // The list arrives from the sidecar; scrolling it before it has rows proves
    // nothing.
    await expect.poll(() => page.getByTestId('restore-row').count(), { timeout: 30_000 }).toBeGreaterThan(20);

    const bars = page.locator('[data-shell-bar]');
    const before = await bars.first().boundingBox();
    const transcript = page.getByTestId('transcript');
    const conversationAt = (await transcript.count()) > 0 ? await transcript.evaluate((el) => el.scrollTop) : null;

    const moved = await scrollPane(page, 'chat-list');
    expect(moved, 'the chat list did not scroll: this project has too few chats to prove anything').toBeGreaterThan(0);

    expect(await bars.first().boundingBox(), 'a bar moved when the chat list scrolled').toEqual(before);
    if (conversationAt !== null) {
      expect(await transcript.evaluate((el) => el.scrollTop), 'the conversation moved with the list').toBe(
        conversationAt,
      );
    }
    expect(await pageOverflow(page), 'the window scrolled with the chat list').toBeLessThanOrEqual(1);
  });
});
