import { mkdirSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The chat's right rail: the column that holds what this conversation has
 * touched, produced and cost — beside the conversation instead of crammed onto
 * the one line above it (docs/agent-workbench.md §8.2.1, §8.2.6).
 *
 * Needs an instance with a chat in it. Pick the project with BEADS_E2E_PROJECT,
 * or the first the instance lists.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3041 BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
 *      npx playwright test tests/e2e/chat-rail.spec.ts
 */

/** Where a run leaves its proof; emptied by nobody, unlike the artifacts folder. */
const SHOTS = 'tests/results';

/** Opening a chat's past is a file read plus a wake; this is the whole way in. */
const WAY_IN_MS = 120_000;

/** The line naming the agent is one line high, whatever the chat has done. */
const ONE_LINE_PX = 44;

async function projectId(request: APIRequestContext): Promise<string> {
  if (process.env.BEADS_E2E_PROJECT) return process.env.BEADS_E2E_PROJECT;
  const api = process.env.BEADS_E2E_BACKEND ?? '';
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as { id: string }[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return projects[0]!.id;
}

/** The first chat this project has, open, with its own line drawn. */
async function openAChat(page: Page, id: string): Promise<void> {
  await page.goto(`/project?id=${id}&tab=chat`);
  await page.getByTestId('restore-row').first().waitFor({ timeout: 60_000 });
  await page.getByTestId('restore-row').first().getByTestId('row-name').click();
  await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
}

/** How wide the rail is drawing, as the screen paints it. */
async function railWidth(page: Page): Promise<number> {
  return page.locator('[data-testid="chat-right-rail"]').evaluate((el) => el.getBoundingClientRect().width);
}

test.describe('the right rail', () => {
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

  test('opens beside a conversation, collapses to an edge, and is still there after a reload', async ({
    page,
    request,
  }) => {
    const id = await projectId(request);
    await openAChat(page, id);

    // Open by default on a screen with room for it.
    const rail = page.locator('[data-testid="chat-right-rail"]');
    await expect(rail, 'the rail was not drawn beside the conversation').toHaveAttribute('data-open', 'true');
    const wide = await railWidth(page);
    expect(wide, `the open rail drew ${wide}px, which is not a column`).toBeGreaterThan(200);
    await page.screenshot({ path: `${SHOTS}/chat-right-rail-open.png` });

    // Shut, it is an edge and not a column, and the conversation takes the width.
    const transcriptOpen = await page
      .getByTestId('transcript')
      .evaluate((el) => el.getBoundingClientRect().width);
    await page.getByTestId('chat-right-rail-toggle').click();
    await expect(rail).toHaveAttribute('data-open', 'false');
    const thin = await railWidth(page);
    expect(thin, `the shut rail drew ${thin}px, which is not an edge`).toBeLessThan(48);
    const transcriptShut = await page
      .getByTestId('transcript')
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(transcriptShut, 'shutting the rail gave the conversation nothing back').toBeGreaterThan(transcriptOpen);
    await page.screenshot({ path: `${SHOTS}/chat-right-rail-shut.png` });

    // And the choice is the reader's, not the page's: it survives a reload.
    await page.reload();
    await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
    await expect(rail, 'the rail came back open after being shut').toHaveAttribute('data-open', 'false');

    // Both ways: opening it again is remembered too.
    await page.getByTestId('chat-right-rail-toggle').click();
    await expect(rail).toHaveAttribute('data-open', 'true');
    await page.reload();
    await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
    await expect(rail, 'the rail came back shut after being opened').toHaveAttribute('data-open', 'true');
  });

  test('the cards a chat has touched are all in the column, and none of them is on its line', async ({
    page,
    request,
  }) => {
    const id = await projectId(request);
    // Twenty-six cards is the chat that was measured drawing a 2277px row
    // inside a 700px pane (bw-p61.3). The chat is the instance's own; what it
    // has touched is this test's, so the case is the same every run.
    const many = Array.from({ length: 26 }, (_, i) => `bw-rail${i + 1}`);
    await page.route('**/api/workbench/session/*', async (route) => {
      const answer = await route.fetch();
      const facts = (await answer.json()) as Record<string, unknown>;
      await route.fulfill({ json: { ...facts, beads: many } });
    });

    await openAChat(page, id);
    const rail = page.locator('[data-testid="chat-right-rail"]');
    await expect(rail).toHaveAttribute('data-open', 'true');

    // Every one of them, drawn — not the first few and a count.
    await expect(rail.getByTestId('bead-chip')).toHaveCount(many.length, { timeout: 30_000 });
    await expect(page.getByTestId('bead-chip-more'), 'the column is still crowding').toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/chat-right-rail-cards.png` });

    // And the line naming the agent carries none of them, at one line high.
    const line = page.getByTestId('session-state').locator('xpath=..');
    await expect(line.getByTestId('bead-chip'), 'cards are still on the chat’s own line').toHaveCount(0);
    const high = await line.evaluate((el) => el.getBoundingClientRect().height);
    expect(high, `the chat's line drew ${high}px high`).toBeLessThanOrEqual(ONE_LINE_PX);
  });
});
