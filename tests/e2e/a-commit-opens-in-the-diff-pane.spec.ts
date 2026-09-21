import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';
import { openGitView } from './open-git-view';

/**
 * The two-pane Git rail, its search, and a commit opened on its own diff,
 * driven against a real repository (bw-g6zy.6).
 *
 * Three things are proved here that no unit test can prove, because all three
 * are about a real screen of a real height:
 *
 *  1. The box a change is written in stays on screen under a file list far too
 *     long to fit. It used to be the last thing in one long column, so a
 *     project with twenty changed files pushed Commit out of sight.
 *  2. The search reaches the whole history rather than the page in hand: a
 *     word typed into it narrows the list to the commits that hold it, and a
 *     qualifier narrows it to one person's work.
 *  3. Pressing a commit draws that commit in the diff pane -- its header and
 *     its patch -- and the Working tree control puts the pane back.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-commit-opens-in-the-diff-pane.spec.ts
 */

const SHOTS = 'tests/results';
const WAY_IN_MS = 120_000;
const FIXTURE = join(__dirname, '..', '.commit-viewer-run');
const REPO = join(FIXTURE, 'repo');

/** The two people whose commits this history holds. */
const WREN = { name: 'Wren Hollis', email: 'wren@example.invalid' };
const SPARROW = { name: 'Sparrow Vane', email: 'sparrow@example.invalid' };

/** The one commit the search goes looking for, by a word only it holds. */
const WANTED = 'teach the kettle to whistle';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A commit by a named person, so `author:` has something real to narrow to. */
function commitAs(who: { name: string; email: string }, subject: string, body?: string): void {
  const message = body ? `${subject}\n\n${body}` : subject;
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: REPO,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
    },
  });
}

/**
 * A repository with a history worth searching and a working tree far too long
 * for one column: twenty-four saved changes by two people, and then eighteen
 * files edited and left unsaved.
 */
function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', '--local', 'user.name', WREN.name);
  git(REPO, 'config', '--local', 'user.email', WREN.email);
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "commit-viewer"',
      'use_beads = false',
      '',
      '[git]',
      'completed_work_branch = "main"',
      '',
    ].join('\n'),
  );
  writeFileSync(join(REPO, '.gitignore'), ['.beads/', '.worktrees/', 'node_modules/', ''].join('\n'));

  const names = Array.from({ length: 18 }, (_, at) => `part-${String(at + 1).padStart(2, '0')}.txt`);
  const body = (tag: string) => `${Array.from({ length: 30 }, (_, at) => `${tag} line ${at + 1}`).join('\n')}\n`;
  for (const name of names) writeFileSync(join(REPO, name), body('old'));
  git(REPO, 'add', '-A');
  commitAs(WREN, 'the files this project starts with');

  // Twenty-two ordinary saved changes, alternating between the two people, so
  // the list is longer than one page and `author:` has both to choose from.
  for (let at = 0; at < 22; at += 1) {
    const name = names[at % names.length];
    writeFileSync(join(REPO, name), body(`take ${at + 2}`));
    git(REPO, 'add', '-A');
    commitAs(at % 2 === 0 ? SPARROW : WREN, `rework ${name} for the ${at + 2}th time`);
  }

  // And the one the search is aimed at: a subject no other commit shares, with
  // a message body long enough that the header has something to clamp.
  writeFileSync(join(REPO, 'kettle.txt'), 'It whistles when it boils.\n');
  git(REPO, 'add', '-A');
  commitAs(
    SPARROW,
    WANTED,
    [
      'The kettle was silent, which meant nobody knew when it had boiled.',
      '',
      'This gives it a whistle, a volume, and a way to be told to be quiet',
      'again -- three lines of writing so the header has something to fold.',
    ].join('\n'),
  );
  git(REPO, 'tag', 'v1');

  // The working tree: eighteen edited files, which is far more than the rail
  // can draw at once.
  for (const name of names) writeFileSync(join(REPO, name), body('unsaved'));
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', {
    data: { name: 'commit-viewer', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/** How far a scrolling region could be scrolled, in pixels. */
async function overflows(page: Page, testid: string): Promise<number> {
  return page
    .getByTestId(testid)
    .evaluate((node) => (node as HTMLElement).scrollHeight - (node as HTMLElement).clientHeight);
}

test.describe('a commit opens in the diff pane', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('the box stays on screen, the search narrows the history, and a commit draws itself', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });

    const project = await fixtureProject(request);
    const chat = aChatSomebodyElseIsIn(REPO, 'Show me what has been going on');

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

      // ---- the box stays on screen -----------------------------------------
      await expect(page.getByTestId('git-unstaged')).toHaveAttribute('data-count', '18', {
        timeout: 60_000,
      });
      // The file list has more in it than it can draw, which is the whole
      // condition that used to push the box away.
      expect(await overflows(page, 'git-changes'), 'the file list is not long enough to prove anything').toBeGreaterThan(
        100,
      );
      // And the box and its button are still there to be pressed.
      await expect(page.getByTestId('git-commit-message')).toBeInViewport();
      await expect(page.getByTestId('git-commit')).toBeInViewport();
      // So are the commits, in their own pane, which scrolls on its own too.
      const commits = page.getByTestId('git-log').getByTestId('git-log-row');
      await expect(commits).toHaveCount(24, { timeout: 60_000 });
      expect(await overflows(page, 'git-log')).toBeGreaterThan(100);
      await expect(page.getByTestId('git-log-ref').first()).toHaveText('main');
      await page.screenshot({ path: `${SHOTS}/bw-g6zy-two-panes.png` });

      // ---- the search reaches the whole history -----------------------------
      const search = page.getByTestId('commit-search-box');
      await search.fill('kettle');
      await expect(commits, 'the search did not narrow the list').toHaveCount(1, { timeout: 30_000 });
      await expect(commits.first()).toContainText(WANTED);
      await page.screenshot({ path: `${SHOTS}/bw-g6zy-search.png` });

      // A qualifier narrows to one person, and it is that person's work only.
      await search.fill('author:Wren');
      await expect(commits.first()).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await commits.allInnerTexts()).every((text) => text.includes('Wren Hollis')), {
        timeout: 30_000,
      }).toBe(true);
      // What was typed is drawn back as a chip that can be taken off again.
      await expect(page.getByTestId('commit-chip-author')).toContainText('Wren');

      // A word nothing holds says so rather than showing yesterday's list.
      await search.fill('nothing holds this word');
      await expect(page.getByTestId('git-log-empty')).toHaveText('No commit matches.', { timeout: 30_000 });

      // ---- a commit, opened on its own diff ---------------------------------
      await search.fill('kettle');
      await expect(commits).toHaveCount(1, { timeout: 30_000 });
      await commits.first().click();

      const details = page.getByTestId('commit-details');
      await expect(details, 'the commit did not open').toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('commit-subject')).toHaveText(WANTED);
      await expect(details).toContainText(SPARROW.name);
      await expect(page.getByTestId('commit-counts')).toContainText('1 file changed');
      await expect(page.getByTestId('commit-body')).toContainText('The kettle was silent');
      // The branch and the tag standing on it, both drawn, in git's own order.
      await expect(details.getByTestId('commit-ref')).toHaveText(['main', 'v1']);
      // And the patch under it is that commit's patch, not the working tree's.
      const section = (path: string) => page.locator(`[data-testid="git-diff-file"][data-path="${path}"]`);
      await expect(section('kettle.txt')).toBeVisible({ timeout: 30_000 });
      await expect(section('part-01.txt')).toHaveCount(0);
      await expect(page.getByTestId('git-diff-view')).toContainText('It whistles when it boils.');
      // The row it came from says it is the one being shown.
      await expect(commits.first()).toHaveAttribute('data-open', 'true');
      await page.screenshot({ path: `${SHOTS}/bw-g6zy-commit-open.png` });

      // ---- and back to the working tree -------------------------------------
      await page.getByTestId('commit-leave').click();
      await expect(details).toHaveCount(0, { timeout: 30_000 });
      await expect(section('part-01.txt')).toBeVisible({ timeout: 30_000 });
      await expect(commits.first()).not.toHaveAttribute('data-open', 'true');
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
