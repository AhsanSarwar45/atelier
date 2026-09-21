import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { bd } from './fixture-board';
import { backend } from './fixture-held';

/**
 * Ctrl+K, and each tab's own search button, open the search for the tab being
 * shown: the conversations on Chat, the cards on Board, the files on Files
 * (bw-21a2.9). Each of them opens in the project being looked at, and the chats
 * say so in the box: `project:<name>`, a word that can be deleted (bw-c1ti.1).
 */
test("Ctrl+K and each tab's search button open that tab's search", async ({ page, request }) => {
  test.setTimeout(300_000);
  // The project is registered only once its board exists: whether a project
  // keeps a board is read when it is added.
  const dir = join(__dirname, '..', '.held-run', `tabs-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  let projectId: string | null = null;

  const opens = async (target: Page, label: string) => {
    const box = target.getByTestId('search-panel').getByTestId('search-input');
    await expect(box).toHaveAttribute('aria-label', label);
    await expect(box).toBeFocused();
    await target.getByTestId('search-close').click();
    await expect(target.getByTestId('search-panel')).toHaveCount(0);
  };

  try {
    execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'pipe' });
    bd(['init', '--prefix', 'tk'], dir);
    mkdirSync(join(dir, '.atelier'), { recursive: true });
    writeFileSync(
      join(dir, '.atelier', 'project.toml'),
      ['schema_version = 1', '', '[project]', `display_name = "${basename(dir)}"`, 'use_beads = true', 'summary = ""', '', '[git]', 'completed_work_branch = "master"', '', '[beads]', 'issue_id_prefix = "tk"', ''].join('\n'),
    );
    writeFileSync(join(dir, 'seed.jsonl'), `${JSON.stringify({ id: 'tk-one1', title: 'Draw the counts', status: 'open', issue_type: 'task', priority: 2 })}\n`);
    bd(['import', '--input', 'seed.jsonl'], dir);
    const made = await request.post(`${backend()}/api/projects`, { data: { name: 'held-tabs', path: dir, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    const project = (await made.json()) as { id: string };
    projectId = project.id;
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    const at = (tab: string) => `/project?id=${encodeURIComponent(project.id)}&tab=${tab}`;

    await page.goto(at('board'));
    await expect(page.getByText('Draw the counts').first()).toBeVisible({ timeout: 90_000 });
    await page.keyboard.press('Control+k');
    await opens(page, 'Search cards');
    await page.getByTestId('open-board-search').click();
    await opens(page, 'Search cards');

    await page.goto(at('files'));
    await expect(page.getByTestId('files-tab')).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press('Control+k');
    await opens(page, 'Search files');
    await page.getByTestId('files-open-search').click();
    await opens(page, 'Search files');

    const listed = page.waitForResponse((r) => r.url().includes('/api/workbench/restore') && r.ok(), { timeout: 60_000 });
    await page.goto(at('chat'));
    await listed;
    await page.keyboard.press('Control+k');
    const box = page.getByTestId('search-panel').getByTestId('search-input');
    await expect(box).toHaveAttribute('aria-label', 'Search chats');
    // The project is in the box, and the Project menu is reading that same word.
    await expect(box).toHaveValue('project:held-tabs ');
    await expect(page.getByTestId('search-filter-project')).toContainText('held-tabs');
    await page.screenshot({ path: 'tests/results/ctrl-k-chat-tab.png' });
    // Deleting the word searches every project again.
    await box.fill('');
    await expect(page.getByTestId('search-filter-project')).toContainText('Project');
    await expect(page.getByTestId('search-tips')).toBeVisible();
    await opens(page, 'Search chats');
  } finally {
    if (projectId) await request.delete(`${backend()}/api/projects/${projectId}`);
    rmSync(dir, { recursive: true, force: true });
  }
});
