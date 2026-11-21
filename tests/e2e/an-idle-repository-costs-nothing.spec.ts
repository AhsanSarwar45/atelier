import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';
import { openGitView } from './open-git-view';

/**
 * A repository nobody is touching costs the computer next to nothing, however
 * it is set up and however many windows show it.
 *
 * The app reads git for the Git panel, the task list and the chat list, and a
 * watcher on the git directory tells it to read again. Nothing bounded that:
 * in a repository whose git commands write into the git directory themselves
 * (a `core.fsmonitor` hook that keeps a stamp there is enough), each read made
 * the watcher report a change and the change made the next read, a few times a
 * second, for as long as a window was open. Every window also read for itself.
 *
 * The repository here counts its own reads: its `core.fsmonitor` hook, which
 * git runs before every command that looks at the working tree, writes one
 * line to a file outside the repository. The hook can also disturb the git
 * directory on every run, which is the worst case a repository can be.
 *
 * Run: scripts/checks/composer-e2e.sh tests/e2e/an-idle-repository-costs-nothing.spec.ts
 */

const WAY_IN_MS = 120_000;
// Tests run side by side, each in a worker of its own, so each worker has its own repository.
const FIXTURE = join(__dirname, '..', `.idle-repository-run-${process.env.TEST_WORKER_INDEX ?? '0'}`);
const REPO = join(FIXTURE, 'repo');
const READS = join(FIXTURE, 'reads.log');
const DISTURB = join(FIXTURE, 'disturb');
const HOOK = join(FIXTURE, 'counting-fsmonitor');

/** How long the repository is left alone, and how many reads that may cost. */
const LEFT_ALONE_MS = 20_000;
const READS_ALLOWED = 6;

/**
 * Git in the fixture repository and nowhere else. The fixture sits inside this
 * project's own repository, and git looks upwards for one: the ceiling makes a
 * command fail when the fixture is not there, instead of running in the
 * repository above and changing its settings.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: FIXTURE } }).trim();
}

/** Reads of the working tree so far. Git asks the hook once per version it speaks; version 2 is asked first. */
function reads(): number {
  if (!existsSync(READS)) return 0;
  return readFileSync(READS, 'utf8').split('\n').filter((line) => line === '2').length;
}

function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', '--local', 'user.name', 'Idle Repository Fixture');
  git(REPO, 'config', '--local', 'user.email', 'idle-repository@example.invalid');
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    ['schema_version = 1', '', '[project]', 'display_name = "idle-repository"', '', '[git]', 'completed_work_branch = "main"', ''].join('\n'),
  );
  writeFileSync(join(REPO, 'README.md'), 'A project made by a test.\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'the files this project starts with');
  // Exit 1 tells git to look at every file itself, so the hook changes nothing
  // git reports; it only counts, and disturbs the git directory when asked to.
  writeFileSync(
    HOOK,
    [
      '#!/bin/sh',
      `echo "$1" >> '${READS}'`,
      `[ -e '${DISTURB}' ] && date +%s%N > '${join(REPO, '.git', 'fixture-stamp')}'`,
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(HOOK, 0o755);
  git(REPO, 'config', '--local', 'core.fsmonitor', HOOK);
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as { id: string; path: string }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', { data: { name: 'idle-repository', path: REPO, isTest: true } });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

async function showTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

/** Open the chat on the fixture repository with its Git panel showing the branch. */
async function openOnGit(page: Page, projectId: string, chatId: string): Promise<void> {
  const listed = page.waitForResponse((r) => r.url().includes('/api/workbench/restore') && r.ok(), { timeout: WAY_IN_MS });
  await page.goto(`/project?id=${projectId}&tab=chat`);
  await listed;
  const row = page.locator(`[data-testid="restore-row"][data-external-id="${chatId}"]`);
  await row.waitFor({ timeout: WAY_IN_MS });
  await row.getByTestId('row-name').click();
  await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
  await openGitView(page);
  await expect(page.getByTestId('git-branch-name')).toHaveText('main', { timeout: 30_000 });
}

/** Leave everything alone and answer how many times the working tree was read meanwhile. */
async function readsWhileLeftAlone(page: Page): Promise<number> {
  // What opening the panel reads has finished before the count starts.
  await page.waitForTimeout(3_000);
  const before = reads();
  await page.waitForTimeout(LEFT_ALONE_MS);
  return reads() - before;
}

test.describe('a repository nobody is touching', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => seedRepository());
  test.afterAll(() => rmSync(FIXTURE, { recursive: true, force: true }));
  test.beforeEach(async ({ page }) => {
    rmSync(DISTURB, { force: true });
    await showTestProjects(page);
  });

  test('is read a bounded number of times when its own git commands disturb the git directory', async ({ page, request }) => {
    const project = await fixtureProject(request);
    const chat = aChatSomebodyElseIsIn(REPO, 'Nothing is happening here');
    try {
      await openOnGit(page, project.id, chat.id);
      writeFileSync(DISTURB, '');

      const cost = await readsWhileLeftAlone(page);

      console.log(`disturbed repository: read the working tree ${cost} times in ${LEFT_ALONE_MS / 1000} s`);
      expect(cost, `the app read the working tree ${cost} times in ${LEFT_ALONE_MS / 1000} s while nothing changed (disturbed repository)`).toBeLessThanOrEqual(READS_ALLOWED);
    } finally {
      rmSync(DISTURB, { force: true });
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  test('is read no more often by three windows than by one', async ({ page, context, request }) => {
    const project = await fixtureProject(request);
    const chat = aChatSomebodyElseIsIn(REPO, 'Nothing is happening here either');
    const others: Page[] = [];
    try {
      await openOnGit(page, project.id, chat.id);
      for (let i = 0; i < 2; i += 1) {
        const other = await context.newPage();
        await showTestProjects(other);
        await openOnGit(other, project.id, chat.id);
        others.push(other);
      }

      const cost = await readsWhileLeftAlone(page);

      console.log(`three windows: read the working tree ${cost} times in ${LEFT_ALONE_MS / 1000} s`);
      expect(cost, `the app read the working tree ${cost} times in ${LEFT_ALONE_MS / 1000} s while nothing changed (three windows)`).toBeLessThanOrEqual(READS_ALLOWED);
    } finally {
      for (const other of others) await other.close();
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
