import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { aProjectOfItsOwn } from './fixture-held';

/**
 * The files' search finds a word inside a file — and not in a file git
 * ignores — opens the file at that line highlighted, and its AI search names
 * the file and the line with a reason, and not the file it made up
 * (bw-21a2.8).
 *
 * The agent is tests/e2e/fixtures/fake-search-agent.mjs, started in place of
 * Claude: run with CLAUDE_PATH pointing at it. It searches through the same
 * MCP tools a real agent is given.
 */
test('a word inside a file finds it, opens it at the line highlighted, and the AI search names it', async ({ page, request }) => {
  test.setTimeout(300_000);
  const project = await aProjectOfItsOwn(request, 'files');
  const word = `cobalt${Date.now()}`;

  try {
    const dir = project.path;
    execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'ignored'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), 'ignored/\n');
    writeFileSync(
      join(dir, 'src', 'importer.rs'),
      ['fn main() {', '    let rows = read();', '    tune(rows);', '}', '', 'fn tune(rows: Rows) {', `    // the ${word} cache stays off while importing`, '    rows.stream();', '}', ''].join('\n'),
    );
    writeFileSync(join(dir, 'ignored', 'notes.txt'), `${word}\n`);
    writeFileSync(join(dir, 'README.md'), '# Nothing here\n');

    const chosen = await request.put('/api/settings/search', {
      data: { provider: 'claude', profile: null, model: null, effort: null, timeLimitSeconds: 60 },
    });
    expect(chosen.ok(), await chosen.text()).toBeTruthy();
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });

    await page.goto(`/project?id=${encodeURIComponent(project.id)}&tab=files`);
    await expect(page.getByTestId('files-tab')).toBeVisible({ timeout: 90_000 });

    // The tab's own search button opens the files' search.
    await page.getByTestId('files-open-search').click();
    const box = page.getByTestId('search-panel').getByTestId('search-input');
    await expect(box).toHaveAttribute('aria-label', 'Search the files');
    await expect(box).toBeFocused();
    await box.fill(`${word} `);

    const file = page.getByTestId('search-file');
    await expect(file).toHaveCount(1, { timeout: 30_000 });
    await expect(file).toHaveAttribute('data-path', 'src/importer.rs');
    const line = file.getByTestId('search-file-line');
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute('data-line', '7');
    await expect(line.getByTestId('search-mark')).toHaveText(word);
    await page.screenshot({ path: 'tests/results/files-search-found.png' });

    // Kept to Markdown, the word is nowhere.
    await box.fill(`${word} ext:md`);
    await expect(page.getByTestId('search-nothing')).toBeVisible();
    await box.fill(`${word} `);
    await expect(file).toHaveCount(1);

    await line.click();
    await expect(page.getByTestId('search-panel')).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]line=7(&|$)/);
    await expect(page).toHaveURL(/importer\.rs/);
    const highlighted = page.locator('.cm-highlighted-line');
    await expect(highlighted).toContainText(word, { timeout: 30_000 });
    await expect(highlighted).toBeInViewport();
    await page.screenshot({ path: 'tests/results/files-search-opened.png' });

    // Ctrl+K on the Files tab opens the files' search, and the AI search names the file.
    await page.getByTestId('files-tab').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('search-panel').getByTestId('search-input')).toHaveAttribute('aria-label', 'Search the files');
    await page.getByTestId('search-mode-ai').click();
    await page.getByTestId('ai-search-input').fill(word);
    await page.getByTestId('ai-search-ask').click();

    const found = page.getByTestId('ai-search-file');
    await expect(found).toHaveCount(1, { timeout: 60_000 });
    await expect(found).toHaveAttribute('data-path', 'src/importer.rs');
    await expect(found.getByTestId('ai-search-reason')).toHaveText(`It is where ${word} came up`);
    await expect(found).toContainText('line 7');
    await expect(page.locator('[data-path="a-file-nobody-had"]')).toHaveCount(0);
    await expect(page.getByTestId('ai-search-step').filter({ hasText: `Searched ${word}` })).toBeVisible();
    await expect(page.getByTestId('ai-search-step').filter({ hasText: 'Read src/importer.rs' })).toBeVisible();
    await expect(page.getByTestId('ai-search-failed')).toHaveCount(0);
    await page.screenshot({ path: 'tests/results/files-ai-search-found.png' });

    await found.click();
    await expect(page).toHaveURL(/[?&]line=7(&|$)/);
    await expect(page.locator('.cm-highlighted-line')).toContainText(word);
  } finally {
    await project.remove();
  }
});
