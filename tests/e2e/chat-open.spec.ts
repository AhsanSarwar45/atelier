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

/**
 * The chats the list is offering, named by the id each will open as.
 *
 * A row is picked by name and not by where it sits: the list is ordered by who
 * spoke last, and a row that has never been opened does not carry its id yet,
 * so those are left out rather than clicked blind.
 */
function chatKeys(page: Page, among = '[data-testid="restore-row"]'): Promise<string[]> {
  return page
    .locator(among)
    .evaluateAll((els) =>
      els
        .map((e) => e.getAttribute('data-row-key'))
        .filter((k): k is string => !!k && !k.startsWith('ext:')),
    );
}

/**
 * Opens one chat and waits for THAT chat to be the one drawn.
 *
 * Waiting for the pane itself proves nothing after the first chat: it is
 * already there, still holding the last conversation, while this one is being
 * read off disk. Every walk in this file used to read the chat it had just
 * left, several times over (bw-khe.5).
 */
async function openChat(page: Page, key: string): Promise<void> {
  await page.locator(`[data-testid="restore-row"][data-row-key="${key}"]`).getByTestId('row-name').click();
  await page.locator(`[data-testid="chat-tab"][data-session-id="${key}"]`).waitFor({ timeout: WAY_IN_MS });
}

/**
 * Waits until the pane has stopped filling.
 *
 * A conversation arrives in one frame and is then drawn a piece at a time, so
 * the first message appearing means the drawing has STARTED. A check that reads
 * there sees two rows of a chat that has eighty, and its answer depends on how
 * busy the machine was — which is what made 'a written-out address is a link'
 * and the report check fail on some runs and pass on others (bw-khe.5).
 */
async function paneSettles(page: Page, still = 600, most = 30_000): Promise<void> {
  const count = () =>
    page.evaluate(() => document.querySelectorAll('[data-testid="transcript"] > *').length);
  const until = Date.now() + most;
  let was = await count();
  while (Date.now() < until) {
    await page.waitForTimeout(still);
    const now = await count();
    if (now === was) return;
    was = now;
  }
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
  // Reading a chat's past off disk and waking it is seconds, and every wait in
  // this file is written for that. The runner's own thirty seconds would cut
  // them all off long before they were allowed to give up, and a whole file of
  // 'Test timeout of 30000ms exceeded' says nothing about the app (bw-khe.5).
  test.describe.configure({ timeout: WAY_IN_MS });

  test('each chat shows its own messages, not the last one’s', async ({ page, request }) => {
    const id = await projectId(request);
    await openChatTab(page, id);

    // Three named chats, not the first three places. The list is ordered by who
    // spoke last, so on a machine with agents running, clicking position 0, 1, 2
    // can open one chat twice while they trade places (bw-khe.5).
    const wanted = (await chatKeys(page)).slice(0, 3);
    expect(wanted.length, 'this instance has fewer than three chats to open').toBe(3);

    // Every paint of the pane is written down as it happens, because the thing
    // being proved is a moment rather than a state: the pane must be EMPTY the
    // first time it carries the new chat's name. Sampling from out here would
    // step over that moment whenever the record came back quickly.
    await page.evaluate(() => {
      const paints: { id: string | null; messages: number }[] = [];
      (window as unknown as { paints: typeof paints }).paints = paints;
      const note = () => {
        const id =
          document.querySelector('[data-testid="chat-tab"]')?.getAttribute('data-session-id') ?? null;
        const messages = document.querySelectorAll(
          '[data-testid="assistant-message"],[data-testid="user-message"]',
        ).length;
        const last = paints[paints.length - 1];
        if (!last || last.id !== id || last.messages !== messages) paints.push({ id, messages });
      };
      note();
      new MutationObserver(note).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    });

    const drawn: { sessionId: string | null; opening: string; messages: number }[] = [];
    for (const key of wanted) {
      await openChat(page, key);
      // The past is read in behind the open, so wait for words rather than paint.
      await expect
        .poll(async () => (await whatIsDrawn(page)).messages, { timeout: 60_000 })
        .toBeGreaterThan(0);
      drawn.push(await whatIsDrawn(page));
    }

    const chats = new Set(drawn.map((d) => d.sessionId));
    expect(chats.size, 'the same chat was opened three times').toBe(3);
    expect(Math.min(...drawn.map((d) => d.messages)), 'a chat opened with nothing in it').toBeGreaterThan(0);

    // The whole complaint: a chat carrying the last one's messages. Each chat's
    // first paint under its own name must be an empty pane — what the reader
    // sees after that is its own, because it is all that was put there.
    //
    // The first messages themselves cannot settle this: a chat that has been
    // going a while opens on the same words as every other one, the line about
    // the session being continued, so three different chats show one opening.
    const paints = await page.evaluate(
      () => (window as unknown as { paints: { id: string | null; messages: number }[] }).paints,
    );
    for (const key of wanted) {
      const first = paints.find((p) => p.id === key);
      expect(first, `${key} was never drawn`).toBeDefined();
      expect(
        first!.messages,
        `the pane already held ${first!.messages} messages the moment it became ${key}`,
      ).toBe(0);
    }
  });

  test('the list holds still while he is clicking it', async ({ page, request }) => {
    const id = await projectId(request);
    await openChatTab(page, id);

    const topSix = () =>
      page
        .locator('[data-testid="restore-row"]')
        .evaluateAll((els) => els.slice(0, 6).map((e) => e.getAttribute('data-row-key')));

    const before = await topSix();
    expect(before.length, 'this instance has fewer than six chats').toBe(6);
    await page.locator('[data-testid="restore-row"]').nth(2).getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
    // Long enough for the working chats to have spoken again several times over.
    await page.waitForTimeout(6000);

    expect(await topSix(), 'the rows moved under the reader’s hand').toEqual(before);
  });

  test('a written-out address is a link', async ({ page, request }) => {
    const id = await projectId(request);
    await openChatTab(page, id);

    // Whichever of them wrote an address out. A chat that never mentions one is
    // not a failure, so this walks until it finds one or runs out of chats —
    // and it takes several: these are working chats, mostly commands and their
    // answers, with two or three things actually said in a whole conversation.
    test.slow();
    const keys = (await chatKeys(page)).slice(0, 8);
    let written = 0;
    for (const key of keys) {
      if (written > 0) break;
      await openChat(page, key);
      await page.getByTestId('assistant-message').first().waitFor({ timeout: 60_000 });
      await paneSettles(page);
      written = await page.evaluate(() => {
        const said = [
          ...document.querySelectorAll(
            '[data-testid="assistant-message"],[data-testid="user-message"]',
          ),
        ];
        let saying = 0;
        for (const message of said) {
          const walk = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
          for (let node = walk.nextNode(); node; node = walk.nextNode()) {
            // An address inside a command or a code block is code and stays
            // code: `curl http://…` is something to copy, not to follow.
            if (node.parentElement?.closest('code,pre')) continue;
            if (!/https?:\/\//.test(node.textContent ?? '')) continue;
            saying++;
            break;
          }
        }
        return saying;
      });
    }
    expect(written, 'none of the chats opened wrote an address out').toBeGreaterThan(0);

    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelectorAll('[data-testid="transcript"] a[href^="http"]').length,
          ),
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
    const worked = page.locator('[data-testid="restore-row"][data-beads]:not([data-beads=""])');
    await worked.first().waitFor({ timeout: 30_000 });
    const [key] = await chatKeys(page, '[data-testid="restore-row"][data-beads]:not([data-beads=""])');
    expect(key, 'no chat in this instance has worked on a card').toBeDefined();
    await openChat(page, key!);
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

    // The card opens OVER what he was reading rather than taking him to the
    // board: he asked to see a ticket, not to leave the conversation, and the
    // address keeps the chat so Back closes the card and leaves him where he
    // was (app-shell.md §1.7). So the proof is the panel and the chat behind it.
    await page.getByTestId('bead-detail').first().waitFor({ timeout: 30_000 });
    // Lowercased on both sides: the panel draws the id in capitals, and what is
    // being proved here is which card opened, not how it is written (bw-1efn).
    expect((await page.getByTestId('bead-detail').first().innerText()).toLowerCase()).toContain(
      wanted!.toLowerCase(),
    );
    expect(page.url(), 'the card did not go into the address').toContain(`card=${wanted}`);

    await page.goBack();
    await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
    await expect(page.getByTestId('bead-detail')).toHaveCount(0);
  });

  test('a report of this chat’s work reaches the chat', async ({ page, request }) => {
    const id = await projectId(request);
    const api = process.env.BEADS_E2E_BACKEND ?? '';
    const reports = (await (await request.get(`${api}/api/reports`)).json()) as { card: string | null }[];
    test.skip(reports.filter((r) => r.card).length === 0, 'this instance has no report naming a card');

    await openChatTab(page, id);
    const worked = page.locator('[data-testid="restore-row"][data-beads]:not([data-beads=""])');
    await worked.first().waitFor({ timeout: 30_000 });

    // Four chats, each read off disk on its first open: the whole way in, four
    // times over, is more than one chat's worth of patience.
    test.slow();

    // Whichever of them worked a card that has a report; a chat with none is not
    // a failure, so the case walks until it finds one or runs out.
    const keys = (
      await chatKeys(page, '[data-testid="restore-row"][data-beads]:not([data-beads=""])')
    ).slice(0, 4);
    let found = 0;
    for (const key of keys) {
      if (found > 0) break;
      await openChat(page, key);
      await page.getByTestId('bead-chip').first().waitFor({ timeout: 60_000 });
      // The chips arrive with the cards this chat worked, a moment behind them,
      // so this waits for the answer itself rather than for the whole
      // conversation to finish drawing — four chats of that is minutes.
      found = await page
        .getByTestId('chat-report-chip')
        .first()
        .waitFor({ timeout: 8_000 })
        .then(() => 1)
        .catch(() => 0);
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
