import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { expect, test } from '@playwright/test';

import { bd } from './fixture-board';
import { backend } from './fixture-held';

/**
 * The board's search finds a card by a word said only in one of its comments,
 * opens that card, and its AI search names the card with a reason — and not
 * the card it made up (bw-21a2.7).
 *
 * The agent is tests/e2e/fixtures/fake-search-agent.mjs, started in place of
 * Claude: run with CLAUDE_PATH pointing at it. It searches through the same
 * MCP tools a real agent is given.
 */
test('a word only in a comment finds its card, opens it, and the AI search names it', async ({ page, request }) => {
  test.setTimeout(300_000);
  // The project is registered only once its board exists: whether a project
  // keeps a board is read when it is added.
  const dir = join(__dirname, '..', '.held-run', `cards-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const word = `saffron${Date.now()}`;
  let projectId: string | null = null;

  try {
    execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'workbench test'], { cwd: dir, stdio: 'pipe' });
    bd(['init', '--prefix', 'sc'], dir);
    mkdirSync(join(dir, '.atelier'), { recursive: true });
    writeFileSync(
      join(dir, '.atelier', 'project.toml'),
      ['schema_version = 1', '', '[project]', `display_name = "${basename(dir)}"`, 'use_beads = true', 'summary = ""', '', '[git]', 'completed_work_branch = "master"', '', '[beads]', 'issue_id_prefix = "sc"', ''].join('\n'),
    );
    const seed = [
      { id: 'sc-tune1', title: 'Tune the importer', description: 'It stalls on large files.', status: 'open', issue_type: 'task', priority: 1 },
      { id: 'sc-other1', title: 'Draw the counts', description: 'Nothing about any cache.', status: 'open', issue_type: 'task', priority: 2 },
    ];
    writeFileSync(join(dir, 'seed.jsonl'), seed.map((card) => JSON.stringify(card)).join('\n') + '\n');
    bd(['import', '--input', 'seed.jsonl'], dir);
    bd(['comments', 'add', 'sc-tune1', `We turned the ${word} cache off and the importer stopped stalling.`, '--author', 'sam'], dir);
    const made = await request.post(`${backend()}/api/projects`, { data: { name: 'held-cards', path: dir, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    const project = (await made.json()) as { id: string };
    projectId = project.id;
    const listed = (await (await request.get(`${backend()}/api/projects?include_test=true`)).json()) as { id: string; usesBeads?: boolean }[];
    expect(listed.find((p) => p.id === project.id)?.usesBeads, 'the app does not see a board in the seeded project').toBe(true);

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

    await page.goto(`/project?id=${encodeURIComponent(project.id)}&tab=board`);
    await expect(page.getByText('Tune the importer').first()).toBeVisible({ timeout: 90_000 });

    // The button where the board's search box was opens the shared search.
    await page.getByTestId('open-board-search').click();
    const box = page.getByTestId('search-input');
    await expect(box).toBeFocused();
    await box.fill(`${word} `);

    const card = page.getByTestId('search-card');
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await expect(card).toHaveAttribute('data-card-id', 'sc-tune1');
    const hit = card.getByTestId('search-card-hit');
    await expect(hit).toHaveAttribute('data-field', 'comment');
    await expect(hit).toContainText('sam');
    await expect(hit.getByTestId('search-mark')).toHaveText(word);
    await page.screenshot({ path: 'tests/results/board-search-comment.png' });

    // Aimed at titles alone, the word is nowhere.
    await page.getByTestId('search-scope-title').click();
    await expect(box).toHaveValue(`in:title ${word} `);
    await expect(page.getByTestId('search-nothing')).toBeVisible();
    await box.fill(`${word} `);
    await expect(card).toHaveCount(1);

    await box.press('ArrowDown');
    await box.press('Enter');
    await expect(page.getByTestId('search-panel')).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]card=sc-tune1/);
    await expect(page.getByRole('dialog').getByText(word).first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/[?&]card=/);

    // Ctrl+K on the board opens the board's search, and the AI search names the card.
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('search-panel').getByTestId('search-input')).toHaveAttribute('aria-label', 'Search the board');
    await page.getByTestId('search-mode-ai').click();
    await page.getByTestId('ai-search-input').fill(word);
    await page.getByTestId('ai-search-ask').click();

    const found = page.getByTestId('ai-search-card');
    await expect(found).toHaveCount(1, { timeout: 60_000 });
    await expect(found).toHaveAttribute('data-card-id', 'sc-tune1');
    await expect(found.getByTestId('ai-search-reason')).toHaveText(`It is where ${word} came up`);
    await expect(found).toContainText('Tune the importer');
    await expect(page.locator('[data-card-id="a-card-nobody-had"]')).toHaveCount(0);
    await expect(page.getByTestId('ai-search-step').filter({ hasText: `Searched ${word}` })).toBeVisible();
    await expect(page.getByTestId('ai-search-step').filter({ hasText: 'Read Tune the importer' })).toBeVisible();
    await expect(page.getByTestId('ai-search-failed')).toHaveCount(0);
    await page.screenshot({ path: 'tests/results/board-ai-search-found.png' });

    await found.click();
    await expect(page).toHaveURL(/[?&]card=sc-tune1/);
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/[?&]card=/);

    // On a phone the search sits in the board's menu, and opens the same panel.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: /^board options$/i }).click();
    await page.getByTestId('board-menu-items').getByRole('menuitem', { name: /^search/i }).click();
    await expect(page.getByTestId('search-panel').getByTestId('search-input')).toBeFocused();
    await page.getByTestId('search-close').click();
    await expect(page.getByTestId('search-panel')).toHaveCount(0);
  } finally {
    if (projectId) await request.delete(`${backend()}/api/projects/${projectId}`);
    rmSync(dir, { recursive: true, force: true });
  }
});
