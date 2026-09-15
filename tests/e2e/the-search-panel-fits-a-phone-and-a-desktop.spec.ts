import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { bd } from './fixture-board';
import { aChatSomebodyElseIsIn, aProjectOfItsOwn, backend, openChatTab } from './fixture-held';

/**
 * The shared search, drawn for chats, cards and files, on a desktop and on a
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

  const dir = join(__dirname, '..', '.held-run', `shots-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  let boardId: string | null = null;

  try {
    execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
    bd(['init', '--prefix', 'sh'], dir);
    mkdirSync(join(dir, '.atelier'), { recursive: true });
    writeFileSync(
      join(dir, '.atelier', 'project.toml'),
      ['schema_version = 1', '', '[project]', `display_name = "${basename(dir)}"`, 'use_beads = true', 'summary = ""', '', '[git]', 'completed_work_branch = "master"', '', '[beads]', 'issue_id_prefix = "sh"', ''].join('\n'),
    );
    const seed = [
      { id: 'sh-tune1', title: 'Tune the importer so large boards stop stalling', description: `The ${word} cache made it worse.`, status: 'in_progress', issue_type: 'bug', priority: 1 },
      { id: 'sh-other1', title: `Count the ${word} rows`, status: 'open', issue_type: 'task', priority: 2 },
    ];
    writeFileSync(join(dir, 'seed.jsonl'), seed.map((card) => JSON.stringify(card)).join('\n') + '\n');
    bd(['import', '--input', 'seed.jsonl'], dir);
    bd(['comments', 'add', 'sh-tune1', `We turned the ${word} cache off and the importer stopped stalling.`, '--author', 'sam'], dir);
    const made = await request.post(`${backend()}/api/projects`, { data: { name: 'held-board', path: dir, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    boardId = ((await made.json()) as { id: string }).id;

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

      await page.goto(`/project?id=${encodeURIComponent(boardId)}&tab=board`);
      await expect(page.getByText('Tune the importer').first()).toBeVisible({ timeout: 90_000 });
      await openSearch();
      await panel.getByTestId('search-input').fill(`${word} `);
      await expect(page.getByTestId('search-card')).toHaveCount(2, { timeout: 30_000 });
      await shot('board-results');
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
    if (boardId) await request.delete(`${backend()}/api/projects/${boardId}`);
    rmSync(dir, { recursive: true, force: true });
  }
});
