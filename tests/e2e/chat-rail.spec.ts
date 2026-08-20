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

/** Long enough to watch the whole fold, which the rail runs in 200ms. */
const FOLD_MS = 400;

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
    // The fold takes 200ms, so the width is read once it has landed and not on
    // the frame the click happened (bw-7ks.22.12).
    await expect
      .poll(() => railWidth(page), { message: 'the shut rail never became an edge', timeout: 5_000 })
      .toBeLessThan(48);
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

  test('a card is named by the job it belongs to, so a chat that worked one job draws one chip', async ({
    page,
    request,
  }) => {
    const id = await projectId(request);
    // The same twenty-six, but as pieces of two jobs — which is what a session
    // that works a job actually touches (bw-7ks.22.11).
    const pieces = [
      ...Array.from({ length: 20 }, (_, i) => `bw-rail1.${i + 1}`),
      ...Array.from({ length: 5 }, (_, i) => `bw-rail2.${i + 1}`),
      'bw-rail2',
    ];
    await page.route('**/api/workbench/session/*', async (route) => {
      const answer = await route.fetch();
      const facts = (await answer.json()) as Record<string, unknown>;
      await route.fulfill({ json: { ...facts, beads: pieces } });
    });

    await openAChat(page, id);
    const rail = page.locator('[data-testid="chat-right-rail"]');
    await expect(rail).toHaveAttribute('data-open', 'true');

    // Two jobs, two chips — and the rail says how many pieces it folded.
    const chips = rail.getByTestId('bead-chip');
    await expect(chips, 'the pieces were drawn one chip each').toHaveCount(2, { timeout: 30_000 });
    await expect(rail).toHaveAttribute('data-pieces', String(pieces.length));
    expect(await chips.evaluateAll((els) => els.map((e) => e.getAttribute('data-bead-id')))).toEqual([
      'bw-rail1',
      'bw-rail2',
    ]);
    // A piece is never drawn as its own chip.
    expect(
      await chips.evaluateAll((els) => els.filter((e) => (e.getAttribute('data-bead-id') ?? '').includes('.')).length),
      'a piece of a job is still a chip of its own',
    ).toBe(0);

    // Nothing is lost: the pointer names every piece the chip stands for.
    const said = (await chips.first().getAttribute('title')) ?? '';
    expect(said, `the chip said "${said}"`).toContain('20 pieces');
    expect(said, 'the pieces are not named').toContain('bw-rail1.20');
    // A job the chat touched itself says nothing about pieces it did not.
    expect((await chips.nth(1).getAttribute('title')) ?? '').toContain('5 pieces');
    await page.screenshot({ path: `${SHOTS}/chat-right-rail-jobs.png` });
  });

  test('folds between its two widths, and holds still when less motion is asked for', async ({ page, request }) => {
    const id = await projectId(request);
    await openAChat(page, id);
    const rail = page.locator('[data-testid="chat-right-rail"]');
    await expect(rail).toHaveAttribute('data-open', 'true');

    // Every width the screen actually paints while it folds, frame by frame.
    const fold = async () =>
      page.evaluate(async (ms) => {
        const el = document.querySelector('[data-testid="chat-right-rail"]') as HTMLElement;
        const handle = document.querySelector('[data-testid="chat-right-rail-toggle"]') as HTMLElement;
        const seen: number[] = [];
        handle.click();
        const from = performance.now();
        await new Promise<void>((done) => {
          const tick = () => {
            seen.push(el.getBoundingClientRect().width);
            if (performance.now() - from < ms) requestAnimationFrame(tick);
            else done();
          };
          requestAnimationFrame(tick);
        });
        return { seen, moves: getComputedStyle(el).transitionProperty };
      }, FOLD_MS);

    const shutting = await fold();
    expect(Math.max(...shutting.seen), 'the rail did not start as a column').toBeGreaterThan(200);
    expect(Math.min(...shutting.seen), 'the rail did not end as an edge').toBeLessThan(48);
    const between = shutting.seen.filter((w) => w > 48 && w < 200);
    expect(
      between.length,
      `the rail went straight from a column to an edge: ${shutting.seen.map(Math.round).join(', ')}`,
    ).toBeGreaterThan(0);
    expect(shutting.moves, 'nothing about the rail is set to move').toContain('width');

    // Asked for less motion, it is the two ends and nothing between them.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const opening = await fold();
    expect(opening.moves, 'the rail still animates for a reader who asked it not to').toBe('none');
    expect(
      opening.seen.filter((w) => w > 48 && w < 200).length,
      `it animated anyway: ${opening.seen.map(Math.round).join(', ')}`,
    ).toBe(0);
    expect(Math.max(...opening.seen), 'the rail never came back').toBeGreaterThan(200);

    // On a narrow screen the column lies over the conversation and darkens it.
    // The darkening belongs to the same fold, so it arrives with the panel.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 700, height: 900 });
    const shade = await page.evaluate(async (ms) => {
      const scrim = document.querySelector('[data-testid="chat-right-rail-scrim"]') as HTMLElement;
      const handle = document.querySelector('[data-testid="chat-right-rail-toggle"]') as HTMLElement;
      const seen: number[] = [];
      handle.click();
      const from = performance.now();
      await new Promise<void>((done) => {
        const tick = () => {
          seen.push(Number(getComputedStyle(scrim).opacity));
          if (performance.now() - from < ms) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
      return seen;
    }, FOLD_MS);
    expect(
      shade.filter((o) => o > 0.05 && o < 0.95).length,
      `the darkening snapped on: ${shade.map((o) => o.toFixed(2)).join(', ')}`,
    ).toBeGreaterThan(0);
  });
});
