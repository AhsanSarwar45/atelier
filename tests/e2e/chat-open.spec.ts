import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The open chat: switching between chats, the words in one, the box you write
 * in, and what can be clicked.
 *
 * Needs an instance with several chats that have something in them, and at least
 * one that has worked on cards. Pick the project with BEADS_E2E_PROJECT, or the
 * first the instance lists.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3027 BEADS_E2E_BACKEND=http://127.0.0.1:3028 \
 *      npx playwright test tests/e2e/chat-open.spec.ts
 */

/** A message may not be drawn in half its column (measured 56% before). */
const SHARE_OF_PANE = 80;

/** Opening a chat's past is a file read plus a wake; this is the whole way in. */
const WAY_IN_MS = 120_000;

async function projectId(request: APIRequestContext): Promise<string> {
  if (process.env.BEADS_E2E_PROJECT) return process.env.BEADS_E2E_PROJECT;
  const api = process.env.BEADS_E2E_BACKEND ?? '';
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as { id: string }[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return projects[0]!.id;
}

async function openChatTab(page: Page, id: string): Promise<void> {
  await page.goto(`/project?id=${id}&tab=chat`);
  await page.getByTestId('restore-row').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2000);
}

/** Which chat is drawn, and the first thing said in it. */
async function whatIsDrawn(page: Page) {
  return page.evaluate(() => {
    const said = [...document.querySelectorAll('[data-testid="assistant-message"],[data-testid="user-message"]')];
    return {
      sessionId: document.querySelector('[data-testid="chat-tab"]')?.getAttribute('data-session-id') ?? null,
      messages: said.length,
      opening: (said[0]?.textContent ?? '').slice(0, 80),
    };
  });
}

test.describe('the open chat', () => {
  test('each chat shows its own messages, not the last one’s', async ({ page, request }) => {
    const id = await projectId(request);
    await openChatTab(page, id);

    const rows = page.locator('[data-testid="restore-row"]');
    const drawn: { sessionId: string | null; opening: string; messages: number }[] = [];
    for (const i of [0, 1, 2]) {
      await rows.nth(i).getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
      // The past is read in behind the open, so wait for words rather than paint.
      await expect
        .poll(async () => (await whatIsDrawn(page)).messages, { timeout: 60_000 })
        .toBeGreaterThan(0);
      drawn.push(await whatIsDrawn(page));
    }

    const chats = new Set(drawn.map((d) => d.sessionId));
    expect(chats.size, 'the same chat was opened three times').toBe(3);
    const openings = new Set(drawn.map((d) => d.opening));
    expect(
      openings.size,
      `three chats opened but ${openings.size} different first messages were drawn`,
    ).toBe(3);
  });

  test('a written-out address is a link', async ({ page, request }) => {
    const id = await projectId(request);
    await openChatTab(page, id);
    await page.getByTestId('restore-row').first().getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });

    // A chat of any length carries addresses; the first that does settles it.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const said = [...document.querySelectorAll('[data-testid="assistant-message"],[data-testid="user-message"]')];
            const written = said.filter((e) => /https?:\/\//.test(e.textContent ?? '')).length;
            const linked = document.querySelectorAll('[data-testid="transcript"] a[href^="http"]').length;
            return written === 0 ? -1 : linked;
          }),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    // And it goes to its own tab rather than replacing the app.
    const target = await page.locator('[data-testid="transcript"] a[href^="http"]').first().getAttribute('target');
    expect(target, 'a link would navigate the app away from the chat').toBe('_blank');
  });

  test('a message uses the column, not half of it', async ({ page, request }) => {
    const id = await projectId(request);
    await openChatTab(page, id);
    await page.getByTestId('restore-row').first().getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
    await page.getByTestId('assistant-message').first().waitFor({ timeout: 60_000 });

    const share = await page.evaluate(() => {
      const said = document.querySelector('[data-testid="assistant-message"]');
      const pane = document.querySelector('[data-testid="transcript"]');
      if (!said || !pane) return 0;
      return (said.getBoundingClientRect().width / pane.getBoundingClientRect().width) * 100;
    });
    expect(Math.round(share), `an answer took ${Math.round(share)}% of its column`).toBeGreaterThanOrEqual(SHARE_OF_PANE);
  });

  test('the writing box is a box, and Send is in it', async ({ page, request }) => {
    const id = await projectId(request);
    await openChatTab(page, id);
    await page.getByTestId('restore-row').first().getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
    await page.getByTestId('composer-frame').waitFor({ timeout: 30_000 });

    const box = await page.evaluate(() => {
      const frame = document.querySelector('[data-testid="composer-frame"]') as HTMLElement;
      const send = (document.querySelector('[data-testid="send-button"]') ??
        document.querySelector('[data-testid="stop-button"]')) as HTMLElement | null;
      const f = frame.getBoundingClientRect();
      const s = send?.getBoundingClientRect();
      return {
        fill: getComputedStyle(frame).backgroundColor,
        page: getComputedStyle(document.body).backgroundColor,
        sendInside: s ? s.right <= f.right + 1 && s.bottom <= f.bottom + 1 && s.left >= f.left - 1 : false,
      };
    });
    expect(box.fill, 'the box is filled with the page’s own colour, so there is nothing to see').not.toBe(box.page);
    expect(box.sendInside, 'Send hangs outside the box it belongs to').toBe(true);
  });

  test('a ticket opens, and the +N gives up its names', async ({ page, request }) => {
    const id = await projectId(request);
    await openChatTab(page, id);

    // A chat that has worked on cards — its row already says so.
    const worked = page.locator('[data-testid="restore-row"]:has([data-testid="row-bead-chip"])');
    await worked.first().waitFor({ timeout: 30_000 });
    await worked.first().getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
    await page.getByTestId('bead-chip').first().waitFor({ timeout: 60_000 });

    const more = page.getByTestId('bead-chip-more');
    if (await more.count()) {
      const hiding = Number(await more.getAttribute('data-more'));
      await more.click();
      await expect.poll(() => page.getByTestId('bead-chip-hidden').count(), { timeout: 10_000 }).toBe(hiding);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    const chip = page.getByTestId('bead-chip').first();
    const wanted = await chip.getAttribute('data-bead-id');
    await chip.click();
    // The board takes the card out of the address once it has opened it, so the
    // proof is the panel, not the URL.
    await page.getByTestId('bead-detail').first().waitFor({ timeout: 30_000 });
    expect(page.url(), 'the click did not land on the board').toContain('tab=board');
    expect(await page.getByTestId('bead-detail').first().innerText()).toContain(wanted!);
  });

  test('a report of this chat’s work reaches the chat', async ({ page, request }) => {
    const id = await projectId(request);
    const api = process.env.BEADS_E2E_BACKEND ?? '';
    const reports = (await (await request.get(`${api}/api/reports`)).json()) as { card: string | null }[];
    test.skip(reports.filter((r) => r.card).length === 0, 'this instance has no report naming a card');

    await openChatTab(page, id);
    const worked = page.locator('[data-testid="restore-row"]:has([data-testid="row-bead-chip"])');
    await worked.first().waitFor({ timeout: 30_000 });

    // Whichever of them worked a card that has a report; a chat with none is not
    // a failure, so the case walks until it finds one or runs out.
    const many = Math.min(await worked.count(), 4);
    let found = 0;
    for (let i = 0; i < many && found === 0; i++) {
      await worked.nth(i).getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
      await page.getByTestId('bead-chip').first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      found = await page.getByTestId('chat-report-chip').count();
    }
    expect(found, 'no chat that worked a reported card showed its report').toBeGreaterThan(0);

    // The chip is a way through to the report's own place under this project,
    // not a viewer of its own (bw-7ks.21.15).
    await page.getByTestId('chat-report-chip').first().click();
    await expect(page).toHaveURL(/tab=reports.*report=/);
    await page.getByTestId('report-tab').waitFor({ timeout: 30_000 });
    await expect(page.locator('iframe')).toHaveCount(0);
  });
});
