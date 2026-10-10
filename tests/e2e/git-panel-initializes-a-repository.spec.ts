import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';

/**
 * The Git tab over a folder with no repository (bw-56ci2.1).
 *
 * The folder is real and so is git: nothing is stubbed. The panel has to say
 * the folder is not a repository, draw none of the controls that need one, and
 * make one when asked — after which it is the ordinary panel, and it follows
 * a commit made in a terminal like any other repository.
 *
 * The folder is made in the home directory rather than under `tests/`,
 * because everything under `tests/` is inside this project's own checkout and
 * git would find that repository instead of none.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/git-panel-initializes-a-repository.spec.ts
 */

const SHOTS = 'tests/results';
const WAY_IN_MS = 120_000;

let FOLDER = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const made = await request.post('/api/projects', {
    data: { name: 'git-panel-init', path: FOLDER, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('the Git tab over a folder with no repository', () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    FOLDER = mkdtempSync(join(homedir(), '.atelier-e2e-git-init-'));
    writeFileSync(join(FOLDER, 'notes.md'), 'What this project is for.\n');
    // The case is about a folder git finds nothing for; say so if it is not one.
    let found = true;
    try {
      git(FOLDER, 'rev-parse', '--git-dir');
    } catch {
      found = false;
    }
    expect(found, `${FOLDER} is inside a repository already`).toBe(false);
  });

  test.afterAll(() => {
    if (FOLDER) rmSync(FOLDER, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    await page.addInitScript(() => {
      localStorage.setItem('workbench.right-rail', '1');
      localStorage.setItem('workbench.git-panel', '1');
    });
  });

  test('says there is no repository, makes one, and becomes the ordinary panel', async ({
    page,
    request,
  }) => {
    const project = await fixtureProject(request);
    const chat = aChatSomebodyElseIsIn(FOLDER, 'Start a project here');

    try {
      const listed = page.waitForResponse((r) => r.url().includes('/api/workbench/restore') && r.ok(), {
        timeout: WAY_IN_MS,
      });
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await listed;
      const row = page.locator(`[data-testid="restore-row"][data-external-id="${chat.id}"]`);
      await row.waitFor({ timeout: WAY_IN_MS });
      await row.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });

      // ---- no repository ----------------------------------------------------
      const empty = page.getByTestId('git-no-repository');
      await expect(empty).toBeVisible({ timeout: 30_000 });
      await expect(empty).toContainText('Not a Git repository');
      const init = page.getByRole('button', { name: 'Initialize repository' });
      await expect(init).toBeVisible();
      for (const gone of ['git-branch', 'git-fetch', 'git-pull', 'git-push', 'git-commit', 'git-error']) {
        await expect(page.getByTestId(gone), `${gone} is drawn with no repository`).toHaveCount(0);
      }
      // It stays that way across the panel's own re-reads.
      await page.waitForTimeout(6_000);
      await expect(empty).toBeVisible();
      await expect(page.getByTestId('git-error')).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/git-panel-no-repository.png` });

      // ---- initialize -------------------------------------------------------
      await init.click();
      await expect(page.getByTestId('git-commit')).toBeVisible({ timeout: 30_000 });
      await expect(empty).toHaveCount(0);
      expect(existsSync(join(FOLDER, '.git')), 'git init did not run').toBe(true);
      await expect(
        page.getByTestId('git-untracked').locator('[data-testid="git-file"][data-path="notes.md"]'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('git-error')).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/git-panel-initialized.png` });

      // ---- and it is watched like any other repository ----------------------
      git(FOLDER, 'config', '--local', 'user.name', 'Git Init Fixture');
      git(FOLDER, 'config', '--local', 'user.email', 'git-init-fixture@example.invalid');
      git(FOLDER, 'config', '--local', 'commit.gpgsign', 'false');
      git(FOLDER, 'add', '-A');
      git(FOLDER, 'commit', '-m', 'the first commit');
      await expect(page.getByTestId('git-clean')).toBeVisible({ timeout: 30_000 });
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  test('a repository made in a terminal is noticed without a refresh', async ({ page, request }) => {
    rmSync(join(FOLDER, '.git'), { recursive: true, force: true });
    const project = await fixtureProject(request);
    const chat = aChatSomebodyElseIsIn(FOLDER, 'Start a project here');

    try {
      const listed = page.waitForResponse((r) => r.url().includes('/api/workbench/restore') && r.ok(), {
        timeout: WAY_IN_MS,
      });
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await listed;
      const row = page.locator(`[data-testid="restore-row"][data-external-id="${chat.id}"]`);
      await row.waitFor({ timeout: WAY_IN_MS });
      await row.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
      await expect(page.getByTestId('git-no-repository')).toBeVisible({ timeout: 30_000 });

      git(FOLDER, 'init', '-q', '-b', 'main', '.');

      await expect(page.getByTestId('git-commit')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('git-no-repository')).toHaveCount(0);
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
