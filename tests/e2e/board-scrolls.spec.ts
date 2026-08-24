import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * A column is as tall as the board, and scrolls inside itself.
 *
 * The row of columns has one row and it is given a height; left to itself a
 * grid row is as tall as the tallest thing in it, and the tallest thing in this
 * one is a list of every card in a column. That made the column five hundred
 * cards tall, put its scrolling pane past the bottom of the window, and left
 * the pane with nothing to scroll — so every card below the fold was drawn
 * where nobody could reach it (bw-57eg).
 *
 * Needs an instance holding a project with more cards in one column than fit on
 * the screen. Pick one with BEADS_E2E_PROJECT, or the first the instance lists.
 *
 * Run: npx playwright test tests/e2e/board-scrolls.spec.ts --project=chromium
 */

/** How far the pane is asked to move, and where it has to end up. */
const SCROLL_BY = 500;

async function projectId(request: APIRequestContext): Promise<string> {
  if (process.env.BEADS_E2E_PROJECT) return process.env.BEADS_E2E_PROJECT;
  const api = process.env.BEADS_E2E_BACKEND ?? '';
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as { id: string }[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return projects[0].id;
}

test.describe('the board scrolls down', () => {
  test('a column is bounded by the board, and its cards scroll inside it', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=board`);
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('column-scroll').first()).toBeVisible({ timeout: 30_000 });

    // The board draws only the cards in front of the reader, so a column's
    // pane fills a moment after the cards land.
    await expect
      .poll(
        () =>
          page
            .getByTestId('column-scroll')
            .evaluateAll((els) => els.filter((el) => el.scrollHeight > el.clientHeight).length),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    // Every column is the height of the box the columns are drawn in. One that
    // is taller has taken its height from its own list, which is the fault.
    const boxed = await page.getByTestId('board-scroll').evaluate((board) => {
      const grid = board.firstElementChild as HTMLElement;
      const columns = [...grid.children] as HTMLElement[];
      return {
        board: grid.clientHeight,
        tallest: Math.max(...columns.map((el) => el.clientHeight)),
      };
    });
    expect(boxed.board, 'the board has no height to bound a column with').toBeGreaterThan(0);
    expect(boxed.tallest, 'a column is taller than the board that holds it').toBeLessThanOrEqual(boxed.board);

    // And the pane inside the full column carries the cards that do not fit.
    const moved = await page.getByTestId('column-scroll').evaluateAll((els, by) => {
      const pane = els.find((el) => el.scrollHeight > el.clientHeight);
      if (!pane) return null;
      pane.scrollTop = by;
      return { at: pane.scrollTop, hidden: pane.scrollHeight, shown: pane.clientHeight };
    }, SCROLL_BY);
    expect(moved, 'no column holds more cards than fit: this project proves nothing').not.toBeNull();
    expect(moved!.hidden, 'the pane has nothing to scroll').toBeGreaterThan(moved!.shown);
    expect(moved!.at, 'the column did not scroll').toBe(SCROLL_BY);
  });
});
