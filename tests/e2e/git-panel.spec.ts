import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';

/**
 * The Git view in the chat's right rail, driven against a real repository
 * (bw-8dp8, bw-8dp8.6).
 *
 * The whole point of this case is that nothing in it is a mock. It makes a
 * repository on disk with `git init`, gives it a shared copy to follow, seeds
 * it into the three states a project is ever in at once — one tracked file
 * changed, one file new, one file already picked — and then reads the panel.
 * The last act is the one that matters: it picks the changed file up FROM THE
 * RAIL, types a message, presses Commit, and then asks git itself, with
 * `git log -1` in that repository, whether the commit is there. A panel that
 * drew everything correctly against a stub would fail on that line.
 *
 * The repository is this case's own and is thrown away afterwards. It is never
 * the developer's checkout: the case commits, and a case that commits into
 * somebody's work is a case that cannot be run.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/git-panel.spec.ts
 */

/** Where a run leaves its proof; not the artifacts folder, which is emptied. */
const SHOTS = 'tests/results';

/** Opening a chat is a file read plus a wake; this is the whole way in. */
const WAY_IN_MS = 120_000;

/**
 * Everything this case makes, in one folder it can delete whole: the shared
 * copy, the checkout the app is pointed at, and the second checkout that makes
 * the shared copy move on without touching the first.
 */
const FIXTURE = join(__dirname, '..', '.git-panel-run');
const SHARED = join(FIXTURE, 'shared.git');
const REPO = join(FIXTURE, 'repo');
const OTHER = join(FIXTURE, 'other');

/** The file that is tracked and changed: in the working tree, not the index. */
const CHANGED = 'notes.md';

/** The file that is already picked, on a path with a folder in it. */
const PICKED = 'src/handoff.ts';

/** And the file git has never been told about. */
const NEW = 'scratch.txt';

/** What the two saved changes the shared copy already has are called. */
const FIRST_SAVE = 'the files this project starts with';
const SECOND_SAVE = 'a second saved change';

/** The one this checkout has made and not sent: it is one ahead. */
const OURS = 'a change made here and not sent yet';

/** And the one somebody else sent: it is one behind. */
const THEIRS = 'a change somebody else sent';

/** What the case types into the box and then looks for in git's own log. */
const MESSAGE = 'Save the notes the panel picked up';

/** git, run in a directory, answering with what it printed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Who this repository's commits are by, and that they are not signed.
 *
 * Written into the repository's OWN config rather than the environment,
 * because the commit under test is made by the server: it shells out to git in
 * this directory with its own environment, so anything the test exports is
 * gone by then. `commit.gpgsign` is turned off for the same reason — a machine
 * whose global config signs every commit has no terminal here to ask for the
 * passphrase, and the commit would hang rather than fail.
 */
function settle(repo: string): void {
  git(repo, 'config', '--local', 'user.name', 'Git Panel Fixture');
  git(repo, 'config', '--local', 'user.email', 'git-panel-fixture@example.invalid');
  git(repo, 'config', '--local', 'commit.gpgsign', 'false');
  // A global `core.hooksPath` would otherwise reach into this repository too.
  git(repo, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
}

/** A file with something in it, folders and all. */
function put(repo: string, path: string, text: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

/**
 * A repository on disk in all three states at once, one ahead of its shared
 * copy and one behind it.
 *
 * The shared copy is a bare repository beside it and the second checkout is
 * how it moves on, so "behind" is a real ref this checkout has fetched rather
 * than a number typed into a fixture.
 */
function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });

  git(FIXTURE, 'init', '--bare', '-b', 'main', SHARED);
  git(FIXTURE, 'clone', SHARED, REPO);
  settle(REPO);

  put(REPO, CHANGED, 'What this project is for.\n');
  put(REPO, 'README.md', 'A project made by a test.\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', FIRST_SAVE);

  put(REPO, 'README.md', 'A project made by a test, and said twice.\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', SECOND_SAVE);
  git(REPO, 'push', '--set-upstream', 'origin', 'main');

  // One saved change of ours that the shared copy has not got: ahead by one.
  put(REPO, 'kept.txt', 'Saved here first.\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', OURS);

  // And one of somebody else's that we have not got: behind by one. Fetched,
  // not pulled, so the working tree is untouched and the count is real.
  git(FIXTURE, 'clone', SHARED, OTHER);
  settle(OTHER);
  put(OTHER, 'theirs.txt', 'Sent from somewhere else.\n');
  git(OTHER, 'add', '-A');
  git(OTHER, 'commit', '-m', THEIRS);
  git(OTHER, 'push');
  git(REPO, 'fetch', 'origin');

  // The three states the panel has to tell apart.
  put(REPO, CHANGED, 'What this project is for, rewritten by an agent.\n');
  put(REPO, PICKED, 'export const handoff = true;\n');
  git(REPO, 'add', '--', PICKED);
  put(REPO, NEW, 'Nobody has told git about this.\n');
}

/**
 * A project of this case's own, pointed at that repository and marked as a
 * test project so it stays off the owner's dashboard and is swept up after.
 */
async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', {
    data: { name: 'git-panel', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/** One row of the panel, found by the file it names. */
function fileRow(page: Page, group: string, path: string) {
  return page.getByTestId(group).locator(`[data-testid="git-file"][data-path="${path}"]`);
}

test.describe('the Git view in the chat’s rail', () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  /**
   * A test project is left off the plain list, which is the list the project
   * page reads for everything but the project itself — so this page asks for
   * them too, and a real visitor typing the same address still sees none.
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('draws what the project has changed, and saves a change into the repository itself', async ({
    page,
    request,
  }) => {
    const project = await fixtureProject(request);
    // A chat to open, written rather than run: the button onto the Git view
    // only exists on a chat, and driving a real agent to get one would be a
    // test of that agent.
    const chat = aChatSomebodyElseIsIn(REPO, 'Rewrite the notes for me');

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

      // ---- the door ---------------------------------------------------------
      // Shut the rail first, so what the Git button does is opening it and not
      // merely swapping the view of a column that was already there.
      const rail = page.locator('[data-testid="chat-right-rail"]');
      const toggle = page.getByTestId('chat-git-toggle');
      await expect(toggle, 'the chat’s bar carries no way into Git').toBeVisible({ timeout: WAY_IN_MS });
      if ((await rail.getAttribute('data-open')) === 'true') {
        await page.getByTestId('chat-right-rail-toggle').click();
      }
      await expect(rail).toHaveAttribute('data-open', 'false');

      await toggle.click();
      await expect(rail, 'the Git button did not open the rail').toHaveAttribute('data-open', 'true');
      await expect(toggle, 'the button does not say it is showing Git').toHaveAttribute('data-open', 'true');
      const view = page.getByTestId('git-view');
      await expect(view, 'the rail opened on something other than Git').toBeVisible({ timeout: 30_000 });

      // ---- the line of work -------------------------------------------------
      await expect(page.getByTestId('git-branch-name')).toHaveText('main', { timeout: 30_000 });
      await expect(page.getByTestId('git-upstream')).toHaveText('origin/main');
      // One saved here and not sent, one sent by somebody else and not taken.
      await expect(page.getByTestId('git-ahead'), 'the branch does not say how far ahead it is').toHaveAttribute(
        'data-count',
        '1',
      );
      await expect(page.getByTestId('git-behind'), 'the branch does not say how far behind it is').toHaveAttribute(
        'data-count',
        '1',
      );

      // ---- the three groups -------------------------------------------------
      await expect(page.getByTestId('git-staged')).toHaveAttribute('data-count', '1');
      await expect(fileRow(page, 'git-staged', PICKED), 'the file already picked is not in Staged').toBeVisible();
      await expect(fileRow(page, 'git-staged', PICKED)).toHaveAttribute('data-status', 'A');

      await expect(page.getByTestId('git-unstaged')).toHaveAttribute('data-count', '1');
      await expect(
        fileRow(page, 'git-unstaged', CHANGED),
        'the changed file is not in Not staged',
      ).toBeVisible();
      await expect(fileRow(page, 'git-unstaged', CHANGED)).toHaveAttribute('data-status', 'M');

      await expect(page.getByTestId('git-untracked')).toHaveAttribute('data-count', '1');
      await expect(fileRow(page, 'git-untracked', NEW), 'the new file is not in Untracked').toBeVisible();

      // ---- the message box and the history ----------------------------------
      await expect(page.getByTestId('git-commit-message'), 'there is nowhere to say what changed').toBeVisible();
      const history = page.getByTestId('git-log').getByTestId('git-log-row');
      await expect(history).toHaveCount(3, { timeout: 30_000 });
      await expect(history.first(), 'the newest saved change is not at the top').toContainText(OURS);
      await expect(history.nth(1)).toContainText(SECOND_SAVE);
      await expect(history.nth(2)).toContainText(FIRST_SAVE);
      // The change somebody else sent is on the shared copy and not here, so
      // it must not be in this list.
      await expect(page.getByTestId('git-log')).not.toContainText(THEIRS);
      await page.screenshot({ path: `${SHOTS}/git-panel-open.png` });

      // ---- picking a file up, from the rail ---------------------------------
      await fileRow(page, 'git-unstaged', CHANGED).getByTestId('git-stage-file').click();
      await expect(page.getByTestId('git-staged'), 'the file was not picked up').toHaveAttribute('data-count', '2');
      await expect(fileRow(page, 'git-staged', CHANGED)).toBeVisible();
      await expect(page.getByTestId('git-unstaged'), 'the file is still down as not picked').toHaveCount(0);
      // git agrees, which is the only opinion that counts.
      expect(git(REPO, 'diff', '--cached', '--name-only').split('\n').sort()).toEqual([CHANGED, PICKED].sort());

      // ---- saying what changed, and saving it -------------------------------
      await page.getByTestId('git-commit-message').fill(MESSAGE);
      const save = page.getByTestId('git-commit');
      await expect(save, 'the Commit button does not say what it would save').toHaveText('Commit 2 files');
      await expect(save).toBeEnabled();
      await page.screenshot({ path: `${SHOTS}/git-panel-ready-to-commit.png` });
      await save.click();

      // The panel reads the repository again rather than guessing: nothing is
      // picked any more, the box is empty, and the new save is at the top.
      await expect(page.getByTestId('git-staged'), 'the panel still shows files as picked').toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page.getByTestId('git-commit-message')).toHaveValue('');
      await expect(page.getByTestId('git-error')).toHaveCount(0);
      await expect(history.first(), 'the new saved change is not in the list').toContainText(MESSAGE);
      await expect(page.getByTestId('git-ahead'), 'the branch is not two ahead now').toHaveAttribute(
        'data-count',
        '2',
      );
      await page.screenshot({ path: `${SHOTS}/git-panel-committed.png` });

      // ---- and git itself ---------------------------------------------------
      // The crux. Everything above could be drawn from a stub; this asks the
      // repository on disk.
      expect(git(REPO, 'log', '-1', '--pretty=%s'), 'git has no such commit').toBe(MESSAGE);
      expect(
        git(REPO, 'show', '--name-only', '--pretty=', 'HEAD').split('\n').filter(Boolean).sort(),
        'the commit does not hold the files the panel picked',
      ).toEqual([CHANGED, PICKED].sort());
      // What was never picked is still where it was, unsaved.
      expect(git(REPO, 'status', '--porcelain', '--untracked-files=all')).toBe(`?? ${NEW}`);
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
