import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The list of chats, and the way into one.
 *
 * Needs an instance whose project has chats a person started and chats an agent
 * started for another chat — measured on Corsetta, 306 offered and 218 a
 * person's. Pick one with BEADS_E2E_PROJECT, or the first the instance lists.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3021 BEADS_E2E_BACKEND=http://127.0.0.1:3018 \
 *      npx playwright test tests/e2e/chat-list.spec.ts
 */

/** One line of chrome, whatever the chat has touched. */
const ONE_LINE_MS = 48;

async function projectId(request: APIRequestContext): Promise<string> {
  if (process.env.BEADS_E2E_PROJECT) return process.env.BEADS_E2E_PROJECT;
  const api = process.env.BEADS_E2E_BACKEND ?? '';
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as { id: string }[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return projects[0].id;
}

test.describe('the list of chats', () => {
  test('holds the ones you started, and the switch brings the agents’ own back', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('restore-row').first().waitFor();
    await page.waitForTimeout(1500);

    const names = await page.getByTestId('row-name').allInnerTexts();
    expect(names.length, 'nothing in the list to judge').toBeGreaterThan(0);
    expect(
      names.filter((n) => /reviewing a change/i.test(n)),
      'a chat an agent started for another chat is in the list by default',
    ).toEqual([]);

    // The list draws a screenful and grows as it is pulled, so what the switch
    // changes is read off what the list holds, not off how many rows are drawn.
    const held = () =>
      page.getByTestId('chat-list-more').innerText().then(
        (t) => Number(t.replace(/\D+/g, '')),
        () => 0,
      );
    const before = await held();

    await page.getByTestId('toggle-everything').click();
    await expect.poll(held, { timeout: 15_000 }).toBeGreaterThan(before);
    expect(
      (await page.getByTestId('row-name').allInnerTexts()).some((n) => /reviewing a change/i.test(n)) ||
        (await held()) > before,
      'the switch let nothing new in',
    ).toBe(true);

    // And back off again, since it is remembered between visits.
    await page.getByTestId('toggle-everything').click();
    await expect.poll(held, { timeout: 15_000 }).toBe(before);
  });

  test('a chat opens when its name is clicked, and the same click wakes it', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('restore-row').first().waitFor();
    await page.waitForTimeout(1000);

    expect(await page.getByTestId('resume-row').count(), 'a Resume button is still in the list').toBe(0);

    const asleep = page.locator('[data-testid="restore-row"][data-state="dormant"]');
    await asleep.first().waitFor({ timeout: 15_000 });
    await asleep.first().getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
  });

  test('an opened chat shows what was said in it before', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('restore-row').first().waitFor();
    await page.waitForTimeout(1000);

    // A chat this app has never driven — its row is offered under the
    // conversation's own id, so nothing about it can already be in our log.
    const untouched = page.locator('[data-testid="restore-row"][data-state="dormant"][data-row-key^="ext:"]');
    await untouched.first().waitFor({ timeout: 15_000 });
    await untouched.first().getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });

    // Nothing has been typed, so anything in the transcript was said before.
    await expect
      .poll(async () => page.locator('[data-testid="assistant-message"], [data-testid="user-message"]').count(), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0);
  });

  test('what an open chat says about itself stays one line', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('restore-row').first().waitFor();

    // The chat with the most cards on it, since that is the one that crowds the
    // open chat's own line. The row no longer draws them, so it is read off the
    // ids the row carries.
    const ready = page.locator('[data-testid="restore-row"]:not([data-state="dormant"])');
    await ready.first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    const counts = await ready.evaluateAll((rows) =>
      rows.map((r) => (r.getAttribute('data-beads') ?? '').split(' ').filter(Boolean).length),
    );
    const most = counts.reduce((best, n, i) => (n > counts[best] ? i : best), 0);
    const pick = ready.nth(counts.length > 0 && counts[most] > 0 ? most : 0);
    await pick.getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1000);

    // None of them, now: the cards are in the rail, which is a column, and the
    // line keeps only what names the agent (docs/agent-workbench.md §8.2.1).
    const onTheLine = await page.getByTestId('chat-status-line').getByTestId('bead-chip').count();
    expect(onTheLine, `${onTheLine} cards were drawn on the line`).toBe(0);

    const line = await page.evaluate(() => {
      const meta = document.querySelector('[data-testid="session-meta"]') as HTMLElement | null;
      const head = document.querySelector('[data-testid="chat-status-line"]') as HTMLElement | null;
      return {
        height: Math.round(head?.getBoundingClientRect().height ?? 0),
        overflow: head ? Math.round(head.scrollWidth - head.clientWidth) : 0,
        metaLines: meta ? Math.round(meta.getBoundingClientRect().height / 18) : 0,
        metaWidth: Math.round(meta?.getBoundingClientRect().width ?? 0),
        wanted: meta?.scrollWidth ?? 0,
      };
    });

    expect(line.height, `the header is ${line.height}px high`).toBeLessThanOrEqual(ONE_LINE_MS);
    expect(line.overflow, 'the header runs past its own edge').toBeLessThanOrEqual(1);
    expect(line.metaLines, 'the words naming the agent are stacked into a column').toBeLessThanOrEqual(1);
    expect(line.metaWidth, 'the words naming the agent were squeezed').toBeGreaterThanOrEqual(line.wanted - 1);
  });
});
