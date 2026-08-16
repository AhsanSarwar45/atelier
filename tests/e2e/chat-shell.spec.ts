import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The chat screen, as the owner meets it: how long he waits, what a row tells
 * him, and whether any of it is coloured.
 *
 * Needs an instance whose project has chats in it — the waiting only exists
 * when there is something to draw. Pick one with BEADS_E2E_PROJECT, or the
 * first the instance lists.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3021 BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
 *      npx playwright test tests/e2e/chat-shell.spec.ts
 */

async function projectId(request: APIRequestContext): Promise<string> {
  if (process.env.BEADS_E2E_PROJECT) return process.env.BEADS_E2E_PROJECT;
  const api = process.env.BEADS_E2E_BACKEND ?? '';
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as { id: string }[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return projects[0].id;
}

/** Every colour the page draws, as the numbers a screen actually paints. */
async function paintedColour(page: Page, selector: string): Promise<{ text: number[]; fill: number[] }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`nothing matched ${sel}`);
    const style = getComputedStyle(el);
    // Painted colours arrive in whatever space the browser resolved them to,
    // so they are read back through a canvas, which always answers in sRGB.
    const read = (value: string) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!];
    };
    return { text: read(style.color), fill: read(style.backgroundColor) };
  }, selector);
}

/** How far apart the most and least of red, green and blue are. Grey is zero. */
function colourfulness([r, g, b]: number[]): number {
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!);
}

/** What "at once" means for a screen a person is waiting on. */
const AT_ONCE_MS = 1000;

test.describe('the chat screen', () => {
  test('switching to it puts the chats on screen at once, and going back is immediate', async ({ page, request }) => {
    const id = await projectId(request);
    // Both tabs are visited once before the clock starts: against a dev server
    // the first visit to a screen compiles it, which is not what the owner is
    // waiting for when he switches.
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('restore-row').first().waitFor();
    await page.goto(`/project?id=${id}&tab=board`);
    await page.getByTestId('board-scroll').waitFor();

    const toChat = Date.now();
    await page.getByTestId('tab-chat').click();
    await page.getByTestId('restore-row').first().waitFor();
    const chatWait = Date.now() - toChat;

    const toBoard = Date.now();
    await page.getByTestId('tab-board').click();
    await page.getByTestId('board-scroll').waitFor();
    const boardWait = Date.now() - toBoard;

    expect(chatWait, `waited ${chatWait}ms for the chats`).toBeLessThan(AT_ONCE_MS);
    expect(boardWait, `waited ${boardWait}ms for the board`).toBeLessThan(AT_ONCE_MS);
  });

  test('a chat started here appears in the list while it is starting', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('restore-row').first().waitFor();
    const before = await page.getByTestId('restore-row').count();

    await page.getByTestId('new-chat-tool').click();

    // The row is expected while the chat is still starting, so this waits on
    // the list rather than on the conversation being ready to type into.
    await expect
      .poll(async () => page.getByTestId('restore-row').count(), { timeout: 10_000 })
      .toBeGreaterThan(before);
  });

  test('an open chat says where it is working', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('restore-row').first().waitFor();

    // A chat that is already attached opens by being clicked; a dormant one
    // would have to be woken, and nothing here wakes an agent.
    const ready = page.locator('[data-testid="restore-row"]:not([data-state="dormant"]):not([data-state="ended"])');
    await ready.first().waitFor({ timeout: 10_000 }).catch(() => {});
    test.skip((await ready.count()) === 0, 'no chat is attached to open');

    await ready.first().getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor();

    const where = page.getByTestId('chat-folder-chip');
    await expect(where).toBeVisible();
    expect((await where.getAttribute('data-folder')) ?? '', 'the chip names no folder').not.toBe('');
    expect(await where.getAttribute('title'), 'the whole path is not in the tooltip').toContain('/');
  });

  test('the rest of a long list arrives by scrolling to it', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('restore-row').first().waitFor();

    // The first rows can come from the live stream before the fetched list
    // lands, so the marker is waited for rather than counted once.
    const more = page.getByTestId('chat-list-more');
    await more.waitFor({ timeout: 10_000 }).catch(() => {});
    test.skip((await more.count()) === 0, 'this project has too few chats to grow the list');

    const first = await page.getByTestId('restore-row').count();
    await more.scrollIntoViewIfNeeded();
    await expect
      .poll(async () => page.getByTestId('restore-row').count(), { timeout: 5000 })
      .toBeGreaterThan(first);
  });

  test('its tools are icons, and every one of them still says what it is', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('tab-tools').getByRole('button').first().waitFor();

    const tools = page.getByTestId('tab-tools').getByRole('button');
    const count = await tools.count();
    expect(count, 'the chat tab put no tools on the bar').toBeGreaterThan(2);

    for (let i = 0; i < count; i++) {
      const tool = tools.nth(i);
      const name = (await tool.getAttribute('aria-label')) ?? '';
      expect(name, `tool ${i} has no name for anyone who cannot see the picture`).not.toBe('');
      expect(await tool.locator('svg').count(), `"${name}" is drawn as words, not a picture`).toBeGreaterThan(0);
      expect((await tool.innerText()).trim(), `"${name}" still spells itself out on the bar`).toBe('');
    }
  });

  test('a chip on a chat is coloured, not the page\'s own grey', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('row-folder-chip').first().waitFor();

    const chip = await paintedColour(page, '[data-testid="row-folder-chip"]');
    expect(colourfulness(chip.text), `the chip's words came out ${chip.text.join(',')}`).toBeGreaterThan(20);
    expect(colourfulness(chip.fill), `the chip's fill came out ${chip.fill.join(',')}`).toBeGreaterThan(4);
  });
});
