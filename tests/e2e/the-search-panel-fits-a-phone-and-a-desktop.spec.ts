import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { aChatSomebodyElseIsIn, aProjectOfItsOwn, openChatTab } from './fixture-held';

/**
 * The shared search, drawn for chats and files, on a desktop and on a
 * phone: every control reachable, nothing said twice, results readable
 * (bw-ac7z.1). SEARCH_SHOTS names the set of pictures taken.
 */
const SIZES = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, touch: false },
  // A touch screen, so the app's thumb-sized floor on every control is drawn as a phone draws it.
  { name: 'phone', viewport: { width: 390, height: 844 }, touch: true },
] as const;

/** A page of its own at one size, seeing the test projects. */
async function aPageAt(browser: Browser, size: (typeof SIZES)[number], baseURL: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, viewport: size.viewport, hasTouch: size.touch, isMobile: size.touch });
  const page = await context.newPage();
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  return page;
}

test('the search panel fits a phone and a desktop', async ({ browser, request }, testInfo) => {
  test.setTimeout(400_000);
  const tag = process.env.SEARCH_SHOTS ?? 'now';
  const word = `cobalt${Date.now()}`;

  const chats = await aProjectOfItsOwn(request, 'shots');
  const chat = aChatSomebodyElseIsIn(chats.path, 'Tune the importer when large boards stall');
  chat.says(`We switched the ${word} cache off and the importer stopped stalling on the big boards.`);
  // A repository of its own, so the ignore rules of the folder it sits in do not hide its files.
  execFileSync('git', ['init', '-q', '.'], { cwd: chats.path, stdio: 'pipe' });
  mkdirSync(join(chats.path, 'src'), { recursive: true });
  writeFileSync(
    join(chats.path, 'src', 'importer.rs'),
    ['fn main() {', '    let rows = read();', `    // the ${word} cache stays off while importing very large boards`, '    tune(rows);', '}', `fn ${word}_off() {}`, ''].join('\n'),
  );

  try {
    const chosen = await request.put('/api/settings/search', {
      data: { provider: 'claude', profile: null, model: null, effort: null, timeLimitSeconds: 60 },
    });
    expect(chosen.ok(), await chosen.text()).toBeTruthy();
    const baseURL = testInfo.project.use.baseURL!;
    for (const size of SIZES) {
      const page = await aPageAt(browser, size, baseURL);
      const panel = page.getByTestId('search-panel');
      const shot = (name: string) => page.screenshot({ path: `tests/results/search-ui/${tag}-${size.name}-${name}.png` });
      const openSearch = async () => {
        await page.keyboard.press('Control+k');
        await expect(panel.getByTestId('search-input')).toBeFocused();
      };

      await openChatTab(page, chats);
      await expect
        .poll(
          async () => ((await (await request.get(`/api/workbench/search/chats?q=${word}`)).json()) as { chats: unknown[] }).chats.length,
          { timeout: 90_000, intervals: [1_000] },
        )
        .toBe(1);
      await openSearch();
      await page.waitForTimeout(300);
      await shot('chat-empty');
      await panel.getByTestId('search-input').fill(`${word} `);
      await expect(page.getByTestId('search-chat')).toHaveCount(1, { timeout: 30_000 });
      await shot('chat-results');
      await page.getByTestId('search-mode-ai').click();
      await page.getByTestId('ai-search-input').fill(word);
      await page.getByTestId('ai-search-ask').click();
      await expect(page.getByTestId('ai-search-chat')).toHaveCount(1, { timeout: 60_000 });
      await shot('chat-ai');
      await page.getByTestId('search-close').click();

      await page.goto(`/project?id=${encodeURIComponent(chats.id)}&tab=files`);
      await expect(page.getByTestId('files-tab')).toBeVisible({ timeout: 60_000 });
      await openSearch();
      await panel.getByTestId('search-input').fill(`${word} `);
      await expect(page.getByTestId('search-file')).toHaveCount(1, { timeout: 30_000 });
      await shot('files-results');
      await page.getByTestId('search-close').click();
      await page.context().close();
    }
  } finally {
    chat.forget();
    await chats.remove();
  }
});
