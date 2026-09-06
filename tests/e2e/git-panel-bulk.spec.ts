import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';

/** Wait until a dialog has finished fading in, so a picture of it is honest. */
async function settled(dialog: Locator): Promise<void> {
  await expect
    .poll(async () => dialog.evaluate((box) => getComputedStyle(box).opacity), { timeout: 10_000 })
    .toBe('1');
}

/**
 * The Git panel's bulk and destructive actions, against a real repository
 * (bw-8nwh.3).
 *
 * Nothing here is a mock. The repository is made with `git init` on disk, put
 * into the four states a project is ever in at once — a tracked file changed,
 * a file already picked up, a file git has never been told about, and a file
 * the project has told git to look away from — and then driven from the panel:
 * Stage all, Unstage all, Discard all. Every step is read twice, once off the
 * panel and once out of `git status` in that repository, because a panel that
 * drew the right thing against a stub would pass on the first and fail on the
 * second.
 *
 * The one thing neither reading alone would catch is the ignored file. A
 * "discard all" that reached for `git clean -fdx` draws exactly the same clean
 * panel while having deleted somebody's `.env`, their `node_modules` and their
 * build, so this case writes an ignored file first and insists it is still
 * there at the end.
 *
 * Its repository and its project are its own, separate from
 * `git-panel.spec.ts`'s: this case throws whole working trees away, and a
 * fixture shared with a case that is reading one is a fixture that is gone
 * halfway through.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/git-panel-bulk.spec.ts
 */

/** Where a run leaves its proof; not the artifacts folder, which is emptied. */
const SHOTS = 'tests/results';

/** Opening a chat is a file read plus a wake; this is the whole way in. */
const WAY_IN_MS = 120_000;

/** This case's own repository, deleted whole afterwards. */
const FIXTURE = join(__dirname, '..', '.git-panel-bulk-run');
const REPO = join(FIXTURE, 'repo');

/** Tracked and changed in the working tree. */
const CHANGED = 'notes.md';
/** Tracked, changed, and already picked up. */
const PICKED = 'src/handoff.ts';
/** A file git has never been told about. */
const NEW = 'scratch/loose.txt';
/** And one the project has told git to look away from. */
const IGNORED = 'noisy.log';

/** What the tracked files say in the last saved change. */
const SAVED_NOTES = 'What this project is for.\n';
const SAVED_HANDOFF = 'export const handoff = false;\n';

/** git, run in a directory, answering with what it printed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Who this repository's commits are by, and that they are not signed.
 *
 * Written into the repository's own config rather than the environment,
 * because the commands under test are run by the server, which shells out with
 * an environment of its own. `commit.gpgsign` is off for the same reason: a
 * machine that signs every commit has no terminal here to ask for the
 * passphrase, and the seed would hang rather than fail.
 */
function settle(repo: string): void {
  git(repo, 'config', '--local', 'user.name', 'Git Bulk Fixture');
  git(repo, 'config', '--local', 'user.email', 'git-bulk-fixture@example.invalid');
  git(repo, 'config', '--local', 'commit.gpgsign', 'false');
  git(repo, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
}

/** A file with something in it, folders and all. */
function put(repo: string, path: string, text: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

/** A repository holding one of everything the panel can act on. */
function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(REPO, { recursive: true });

  git(REPO, 'init', '-q', '-b', 'main', '.');
  settle(REPO);

  put(REPO, '.gitignore', `${IGNORED}\n`);
  put(REPO, CHANGED, SAVED_NOTES);
  put(REPO, PICKED, SAVED_HANDOFF);
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'the files this project starts with');

  // One changed and not picked, one changed and picked, one git has never
  // heard of, and one it has been told to look away from.
  put(REPO, CHANGED, 'What this project is for, rewritten by an agent.\n');
  put(REPO, PICKED, 'export const handoff = true;\n');
  git(REPO, 'add', '--', PICKED);
  put(REPO, NEW, 'Nobody has told git about this.\n');
  put(REPO, IGNORED, 'A file the project told git to look away from.\n');
}

/** A project of this case's own, marked as a test project so it is swept up. */
async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', {
    data: { name: 'git-panel-bulk', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/** One row of the panel, found by the file it names. */
function fileRow(page: Page, group: string, path: string) {
  return page.getByTestId(group).locator(`[data-testid="git-file"][data-path="${path}"]`);
}

test.describe('the Git panel’s bulk and destructive actions', () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    // A test project is left off the plain list, which is the list the project
    // page reads; a real visitor typing the same address still sees none.
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    // The rail is opened on Git the way the app itself opens it on a return
    // visit: the two things it remembers, set before the page loads. That the
    // BUTTON on the chat's bar opens it is git-panel.spec.ts's assertion and
    // not this one's, and going in this way keeps this case about what the
    // panel does rather than about how it is reached.
    await page.addInitScript(() => {
      localStorage.setItem('workbench.right-rail', '1');
      localStorage.setItem('workbench.git-panel', '1');
    });
  });

  test('picks everything up at once, puts it back, and throws it all away', async ({
    page,
    request,
  }) => {
    const project = await fixtureProject(request);
    const chat = aChatSomebodyElseIsIn(REPO, 'Tidy the whole project up');

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

      // ---- what the panel starts with ---------------------------------------
      await expect(page.getByTestId('git-view')).toBeVisible({ timeout: 30_000 });
      await expect(fileRow(page, 'git-unstaged', CHANGED)).toBeVisible({ timeout: 30_000 });
      await expect(fileRow(page, 'git-staged', PICKED)).toBeVisible();
      await expect(fileRow(page, 'git-untracked', NEW)).toBeVisible();
      // What the project ignores is not a change, and is drawn nowhere.
      await expect(page.getByTestId('git-view')).not.toContainText(IGNORED);
      await page.screenshot({ path: `${SHOTS}/git-panel-bulk-before.png` });

      // ---- stage all --------------------------------------------------------
      await page.getByTestId('git-unstaged').getByTestId('git-stage-all').click();

      // Everything changed and everything new is picked, in one press, and the
      // two groups they came out of are gone.
      await expect(page.getByTestId('git-unstaged'), 'something is still not staged').toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page.getByTestId('git-untracked'), 'something is still untracked').toHaveCount(0);
      await expect(fileRow(page, 'git-staged', CHANGED)).toBeVisible();
      await expect(fileRow(page, 'git-staged', NEW)).toBeVisible();
      // git agrees, which is the only opinion that counts.
      const picked = git(REPO, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
      expect(picked).toEqual([CHANGED, NEW, PICKED].sort());
      expect(picked, 'an ignored file was picked up').not.toContain(IGNORED);
      await page.screenshot({ path: `${SHOTS}/git-panel-bulk-staged.png` });

      // ---- unstage all ------------------------------------------------------
      // Discard all sits on the Not staged group, where every other git client
      // puts it, so putting the index back is the way to it — and is the third
      // bulk action, proved on the way past.
      await page.getByTestId('git-unstage-all').click();
      await expect(page.getByTestId('git-staged'), 'something is still picked').toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(fileRow(page, 'git-unstaged', CHANGED)).toBeVisible();
      expect(git(REPO, 'diff', '--cached', '--name-only')).toBe('');

      // ---- discard all, which asks first ------------------------------------
      await page.getByTestId('git-discard-all').click();
      const asking = page.getByTestId('git-confirm-dialog');
      await expect(asking, 'nothing asked before work was thrown away').toBeVisible();
      await expect(asking).toContainText(/ignored files are kept/i);
      await settled(asking);
      await page.screenshot({ path: `${SHOTS}/git-panel-bulk-confirming.png` });

      // Keeping makes no call at all: the project is still dirty afterwards.
      await page.getByTestId('git-confirm-cancel').click();
      await expect(asking).toHaveCount(0);
      expect(git(REPO, 'status', '--porcelain', '--untracked-files=all')).not.toBe('');

      // And Escape is the same word as Keep, now that the asking is a modal
      // dialog and the keyboard has a way out of it (bw-ahf2.1).
      await page.getByTestId('git-discard-all').click();
      await expect(asking).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(asking).toHaveCount(0);
      expect(
        git(REPO, 'status', '--porcelain', '--untracked-files=all'),
        'Escape threw the work away instead of leaving it alone',
      ).not.toBe('');

      // And agreeing does it.
      await page.getByTestId('git-discard-all').click();
      await expect(page.getByTestId('git-confirm-dialog')).toBeVisible();
      await page.getByTestId('git-confirm').click();

      // ---- read the result off the panel ------------------------------------
      await expect(page.getByTestId('git-clean'), 'the panel does not say the project is clean').toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId('git-error')).toHaveCount(0);
      await expect(page.getByTestId('git-staged')).toHaveCount(0);
      await expect(page.getByTestId('git-unstaged')).toHaveCount(0);
      await expect(page.getByTestId('git-untracked')).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/git-panel-bulk-discarded.png` });

      // ---- and the repository itself ----------------------------------------
      expect(git(REPO, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(
        readFileSync(join(REPO, CHANGED), 'utf8'),
        'the changed file did not go back to what was saved',
      ).toBe(SAVED_NOTES);
      expect(
        readFileSync(join(REPO, PICKED), 'utf8'),
        'the file that was picked up did not go back either',
      ).toBe(SAVED_HANDOFF);
      expect(existsSync(join(REPO, NEW)), 'the new file was not removed').toBe(false);
      // The whole point of `git clean -fd` and never `-fdx`.
      expect(existsSync(join(REPO, IGNORED)), 'an ignored file was deleted').toBe(true);
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
