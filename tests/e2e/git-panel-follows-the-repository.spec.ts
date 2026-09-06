import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';

/**
 * The Git panel keeping up with a repository that moves without it (bw-8nwh.2).
 *
 * The panel read git when it was opened and after its own actions, and never
 * again — so a push made in a terminal, or by an agent working in the same
 * checkout, left "1 ahead" on the screen until somebody pressed refresh. This
 * case is the acceptance of that in full, with nothing mocked: a real
 * repository with a real shared copy, the panel opened on it in a browser, and
 * then `git push` run FROM A SHELL while it is open. Nothing touches the page
 * afterwards. The count has to fall to zero on its own.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/git-panel-follows-the-repository.spec.ts
 */

/** Where a run leaves its proof; not the artifacts folder, which is emptied. */
const SHOTS = 'tests/results';

/** Opening a chat is a file read plus a wake; this is the whole way in. */
const WAY_IN_MS = 120_000;

/** Everything this case makes, in one folder it can delete whole. */
const FIXTURE = join(__dirname, '..', '.git-follows-run');
const SHARED = join(FIXTURE, 'shared.git');
const REPO = join(FIXTURE, 'repo');

/** The one saved change this checkout has that the shared copy has not. */
const OURS = 'a change made here and not sent yet';

/** git, run in a directory, answering with what it printed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Who this repository's commits are by, and that they are not signed. */
function settle(repo: string): void {
  git(repo, 'config', '--local', 'user.name', 'Git Follows Fixture');
  git(repo, 'config', '--local', 'user.email', 'git-follows-fixture@example.invalid');
  git(repo, 'config', '--local', 'commit.gpgsign', 'false');
  git(repo, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
}

/**
 * A repository one saved change ahead of its shared copy, and level with it in
 * every other way — so the push this case makes from a shell is an ordinary
 * fast-forward, and the only number that moves is the one under test.
 */
function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });

  git(FIXTURE, 'init', '--bare', '-b', 'main', SHARED);
  git(FIXTURE, 'clone', SHARED, REPO);
  settle(REPO);

  writeFileSync(join(REPO, 'README.md'), 'A project made by a test.\n');
  // The chat's bar — and with it the way into the Git panel — is drawn only
  // for a project that declares itself one of this app's own, so the fixture
  // says so. Committed rather than left lying about, so the working tree this
  // case reads is clean apart from what it puts there itself.
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "git-follows"',
      'use_beads = true',
      '',
      // Both of these are insisted on for a project that says it uses beads;
      // a manifest without them is refused, and the project comes back as one
      // of the chat-only kind, whose chat has no bar and so no way into Git.
      '[git]',
      'completed_work_branch = "main"',
      '',
      '[beads]',
      'issue_id_prefix = "gf"',
      '',
    ].join('\n'),
  );
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'the files this project starts with');
  git(REPO, 'push', '--set-upstream', 'origin', 'main');

  writeFileSync(join(REPO, 'kept.txt'), 'Saved here first.\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', OURS);
}

/** A project of this case's own, marked as a test project. */
async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', {
    data: { name: 'git-follows', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('the Git panel and a repository that moves without it', () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('a push made in a terminal reaches the panel without anybody pressing refresh', async ({
    page,
    request,
  }) => {
    const project = await fixtureProject(request);
    const chat = aChatSomebodyElseIsIn(REPO, 'Send what we saved');

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

      const toggle = page.getByTestId('chat-git-toggle');
      await expect(toggle).toBeVisible({ timeout: WAY_IN_MS });
      const rail = page.locator('[data-testid="chat-right-rail"]');
      if ((await rail.getAttribute('data-open')) !== 'true' || !(await page.getByTestId('git-view').isVisible())) {
        await toggle.click();
      }
      await expect(page.getByTestId('git-view')).toBeVisible({ timeout: 30_000 });

      // Where it starts: one saved change of ours that the shared copy has not
      // got. This is the number a reader would have gone on seeing for ever.
      await expect(page.getByTestId('git-branch-name')).toHaveText('main', { timeout: 30_000 });
      await expect(page.getByTestId('git-ahead')).toHaveAttribute('data-count', '1', { timeout: 30_000 });
      await page.screenshot({ path: `${SHOTS}/git-follows-before.png` });

      // ---- the act ----------------------------------------------------------
      // A shell, outside the app entirely. Nothing below touches the page.
      git(REPO, 'push');
      expect(git(REPO, 'rev-list', '--count', 'origin/main..HEAD'), 'the push did not land').toBe('0');

      await expect(
        page.getByTestId('git-ahead'),
        'the panel went on saying the branch was ahead after the push',
      ).toHaveAttribute('data-count', '0', { timeout: 60_000 });
      await page.screenshot({ path: `${SHOTS}/git-follows-after.png` });

      // And the refresh button was never pressed: it is still there, still
      // idle, and it was not what changed the number.
      await expect(page.getByTestId('git-refresh')).toBeEnabled();
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
