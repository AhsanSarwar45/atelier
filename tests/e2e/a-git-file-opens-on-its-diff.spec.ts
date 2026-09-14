import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';
import { openGitView } from './open-git-view';

/**
 * Clicking a file in the Git panel opens the diff scrolled to that file
 * (bw-pstm.1), on a real repository with more changes than fit on a screen.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-git-file-opens-on-its-diff.spec.ts
 */

const SHOTS = 'tests/results';
const WAY_IN_MS = 120_000;
const FIXTURE = join(__dirname, '..', '.git-file-opens-run');
const REPO = join(FIXTURE, 'repo');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Twelve edited files of forty lines each, and one untracked file last. */
function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', '--local', 'user.name', 'Git File Opens Fixture');
  git(REPO, 'config', '--local', 'user.email', 'git-file-opens@example.invalid');
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "git-file-opens"',
      'use_beads = true',
      '',
      '[git]',
      'completed_work_branch = "main"',
      '',
      '[beads]',
      'issue_id_prefix = "gf"',
      '',
    ].join('\n'),
  );
  writeFileSync(join(REPO, '.gitignore'), ['.beads/', '.worktrees/', 'node_modules/', ''].join('\n'));
  const names = Array.from({ length: 12 }, (_, at) => `file-${String(at + 1).padStart(2, '0')}.txt`);
  const body = (tag: string) => Array.from({ length: 40 }, (_, at) => `${tag} line ${at + 1}`).join('\n') + '\n';
  for (const name of names) writeFileSync(join(REPO, name), body('old'));
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'start');
  for (const name of names) writeFileSync(join(REPO, name), body('new'));
  writeFileSync(join(REPO, 'zz-untracked.txt'), 'nobody added me\n');
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', {
    data: { name: 'git-file-opens', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('a Git panel file opens on its diff', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('clicking a file name opens the diff scrolled to that file', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });

    const project = await fixtureProject(request);
    const chat = aChatSomebodyElseIsIn(REPO, 'Show me what you changed');

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

      await openGitView(page);
      await expect(page.getByTestId('git-view')).toBeVisible({ timeout: 60_000 });

      const pane = page.getByTestId('git-diff-pane');
      await expect(pane).toHaveCount(0);
      const panelFile = (path: string) =>
        page.locator(`[data-testid="git-file"][data-path="${path}"]`).getByTestId('git-file-name');
      await expect(panelFile('file-11.txt')).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: `${SHOTS}/bw-pstm-before-click.png` });

      // ---- a changed file far down the diff --------------------------------
      await panelFile('file-11.txt').click();
      await expect(pane).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('git-diff-toggle')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('files-tab')).toHaveCount(0);

      const section = (path: string) => page.locator(`[data-testid="git-diff-file"][data-path="${path}"]`);
      const view = page.getByTestId('git-diff-view');
      await expect(section('file-11.txt')).toBeInViewport({ timeout: 30_000 });
      await expect(section('file-01.txt')).not.toBeInViewport();
      // The heading sits at the top of the column, not merely somewhere on it.
      const gap = async (path: string) => {
        const top = (await section(path).boundingBox())!.y;
        return top - (await view.boundingBox())!.y;
      };
      expect(Math.abs(await gap('file-11.txt'))).toBeLessThan(4);
      await page.screenshot({ path: `${SHOTS}/bw-pstm-after-click.png` });

      // ---- the untracked file, with the diff already open ------------------
      await panelFile('zz-untracked.txt').click();
      await expect(section('zz-untracked.txt')).toBeInViewport({ timeout: 30_000 });
      await expect(section('zz-untracked.txt')).toHaveAttribute('data-open', 'true');

      // ---- and back up to the first ----------------------------------------
      await panelFile('file-01.txt').click();
      await expect.poll(() => gap('file-01.txt'), { timeout: 30_000 }).toBeLessThan(4);
      await expect(section('file-11.txt')).not.toBeInViewport();
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
