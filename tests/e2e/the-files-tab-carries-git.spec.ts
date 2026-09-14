import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The Files tab has the same right column the chat has, with the Git tab alone
 * on it, and a changed file in it opens its diff where the file was being read
 * (bw-rpgh.5).
 *
 * There is no chat behind this tab, so there is nothing for an Agents tab to
 * show — the strip carries one tab and the column is Git. What is proved here
 * is that the column opens from the Files tab's own bar, that it offers Git and
 * only Git, and that clicking a file in it swaps the viewer for the diff of
 * that file rather than navigating away.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-files-tab-carries-git.spec.ts
 */

const SHOTS = 'tests/results';
const WAY_IN_MS = 120_000;
const FIXTURE = join(__dirname, '..', '.files-tab-git-run');
const REPO = join(FIXTURE, 'repo');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', '--local', 'user.name', 'Files Tab Git Fixture');
  git(REPO, 'config', '--local', 'user.email', 'files-tab-git@example.invalid');
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "files-tab-git"',
      'use_beads = false',
      '',
      '[git]',
      'completed_work_branch = "main"',
      '',
    ].join('\n'),
  );
  writeFileSync(join(REPO, '.gitignore'), ['.beads/', '.worktrees/', 'node_modules/', ''].join('\n'));
  const body = (tag: string) => Array.from({ length: 30 }, (_, at) => `${tag} line ${at + 1}`).join('\n') + '\n';
  writeFileSync(join(REPO, 'alpha.txt'), body('old'));
  writeFileSync(join(REPO, 'beta.txt'), body('old'));
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'start');
  writeFileSync(join(REPO, 'alpha.txt'), body('new'));
  writeFileSync(join(REPO, 'beta.txt'), body('new'));
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', {
    data: { name: 'files-tab-git', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('the Files tab carries Git', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('the right column offers Git alone and opens a file’s diff in place', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });

    const project = await fixtureProject(request);

    try {
      await page.goto(`/project?id=${project.id}&tab=files`);
      await page.getByTestId('files-tab').waitFor({ timeout: WAY_IN_MS });
      await page.getByTestId('files-tree-slot').waitFor({ timeout: WAY_IN_MS });

      // ---- the column, from this tab's own bar -----------------------------
      const rail = page.getByTestId('chat-right-rail');
      const door = page.getByTestId('files-right-rail-toggle');
      await expect(door).toBeVisible({ timeout: 60_000 });
      if ((await rail.getAttribute('data-open')) !== 'true') await door.click();
      await expect(rail).toHaveAttribute('data-open', 'true', { timeout: 60_000 });

      // ---- one tab on it, and it is Git ------------------------------------
      await expect(page.getByTestId('rail-tab-git')).toBeVisible();
      await expect(
        page.getByTestId('rail-tab-chat'),
        'the Files tab has no chat, so it must not offer an Agents tab',
      ).toHaveCount(0);
      await expect(page.getByTestId('git-view')).toBeVisible({ timeout: 60_000 });

      // ---- a changed file opens its diff, here, not somewhere else ---------
      const pane = page.getByTestId('files-diff-pane');
      await expect(pane).toHaveCount(0);
      const panelFile = (path: string) =>
        page.locator(`[data-testid="git-file"][data-path="${path}"]`).getByTestId('git-file-name');
      await expect(panelFile('beta.txt')).toBeVisible({ timeout: 60_000 });
      await panelFile('beta.txt').click();

      await expect(pane).toBeVisible({ timeout: 60_000 });
      const section = page.locator('[data-testid="git-diff-file"][data-path="beta.txt"]');
      await expect(section).toBeInViewport({ timeout: 30_000 });
      await expect(
        page.getByTestId('files-tab'),
        'the diff stands inside the Files tab; it must not navigate away from it',
      ).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/bw-rpgh-files-tab-git.png` });

      // ---- and the same button puts it away again --------------------------
      await page.getByTestId('git-diff-toggle').click();
      await expect(pane).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
