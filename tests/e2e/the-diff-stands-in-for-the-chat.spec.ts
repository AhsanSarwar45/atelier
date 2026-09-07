import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';
import { quadrantPng } from './fixture-png';

/**
 * The diff standing in for the conversation, on a real repository (bw-rx1y.6).
 *
 * This is the acceptance of the whole epic in one browser, with nothing about
 * git mocked. A repository is made here that carries every kind of change at
 * once — a tracked file edited, a new file picked to be saved, a file git has
 * never been told about, a file deleted, a file moved, and a picture — and a
 * chat is opened in that very checkout. Pressing the rail's diff button has to
 * put those six files where the conversation was, drawn side by side with a
 * number down each edge; clicking a file's name has to ask the machine to open
 * that file in an editor; a seventh change made FROM A SHELL while the diff is
 * on screen has to arrive without anybody touching the page; and pressing the
 * button again, or taking the rail off Git, has to give the conversation back.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-diff-stands-in-for-the-chat.spec.ts
 */

/** Where a run leaves its proof; not the artifacts folder, which is emptied. */
const SHOTS = 'tests/results';

/** Opening a chat is a file read plus a wake; this is the whole way in. */
const WAY_IN_MS = 120_000;

/** The working tree is looked at every five seconds; this is room for several looks. */
const SHELL_EDIT_MS = 40_000;

/** Everything this case makes, in one folder it can delete whole. */
const FIXTURE = join(__dirname, '..', '.diff-stands-in-run');
const REPO = join(FIXTURE, 'repo');

/** git, run in a directory, answering with what it printed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Who this repository's commits are by, and that they are not signed. */
function settle(repo: string): void {
  git(repo, 'config', '--local', 'user.name', 'Diff Stands In Fixture');
  git(repo, 'config', '--local', 'user.email', 'diff-stands-in@example.invalid');
  git(repo, 'config', '--local', 'commit.gpgsign', 'false');
  git(repo, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
}

/** What `edited.txt` says once the case has changed it, and once a shell has. */
const EDITED_FIRST = 'one\ntwo\nthree\nfour\n';
const EDITED_BY_THE_APP = 'one\nTWO\nthree\nfour\n';
const EDITED_BY_A_SHELL = 'one\nTWO\nthree\nFOUR\n';

/**
 * A repository carrying one of every kind of change git can report, and a
 * saved history for them all to be measured against.
 *
 * The names are chosen so that git's own ordering — by path — is the order the
 * screen reads in, which is what lets the case name the six sections it
 * expects rather than hunting for them.
 */
function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(REPO, { recursive: true });

  git(REPO, 'init', '-b', 'main');
  settle(REPO);

  // The chat's bar — and with it the way into the Git rail — is drawn only for
  // a project that declares itself one of this app's own, so the fixture says
  // so, and says it in a commit: an uncommitted manifest would be a seventh
  // change on the screen the case is counting.
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "diff-stands-in"',
      'use_beads = true',
      '',
      '[git]',
      'completed_work_branch = "main"',
      '',
      '[beads]',
      'issue_id_prefix = "ds"',
      '',
    ].join('\n'),
  );
  // Anything the app itself might leave in a project it has been pointed at is
  // not one of this case's six changes, and must not be counted as one.
  writeFileSync(join(REPO, '.gitignore'), ['.beads/', '.worktrees/', 'node_modules/', ''].join('\n'));

  writeFileSync(join(REPO, 'edited.txt'), EDITED_FIRST);
  writeFileSync(join(REPO, 'gone.txt'), 'this line is about to be deleted\n');
  writeFileSync(join(REPO, 'was-here.txt'), 'moved, and not otherwise touched\n');
  writeFileSync(join(REPO, 'picture.png'), quadrantPng(120));
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'the files this project starts with');

  // ---- one of every kind, all at once -------------------------------------
  // Modified, and left unstaged.
  writeFileSync(join(REPO, 'edited.txt'), EDITED_BY_THE_APP);
  // Added: picked to be saved, which is not the same thing as untracked.
  writeFileSync(join(REPO, 'staged-new.txt'), 'brand new, and already picked\n');
  git(REPO, 'add', 'staged-new.txt');
  // Untracked: git has never been told about it.
  writeFileSync(join(REPO, 'never-told.txt'), 'nobody added me\nsecond line\n');
  // Deleted.
  git(REPO, 'rm', '-q', 'gone.txt');
  // Renamed, with the contents left alone so git scores it a pure rename.
  git(REPO, 'mv', 'was-here.txt', 'now-here.txt');
  // A picture, which git will not show as text.
  writeFileSync(join(REPO, 'picture.png'), quadrantPng(60));
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
    data: { name: 'diff-stands-in', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('the diff standing where the conversation stands', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('one button swaps the transcript for this worktree, and gives it back', async ({
    page,
    request,
  }) => {
    // Wide enough that a side-by-side table is read side by side and not as
    // two columns of one word each.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });

    // The one thing this case will not do for real: hand a path to whatever
    // this machine calls an editor. What is under test is that the app asks,
    // and what it asks for — so the ask is caught and answered here.
    const asked: { path?: string; target?: string; line?: number }[] = [];
    await page.route('**/api/fs/open-external', async (route) => {
      asked.push(JSON.parse(route.request().postData() ?? '{}'));
      await route.fulfill({ json: { success: true } });
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

      // ---- the rail, on Git ------------------------------------------------
      const gitToggle = page.getByTestId('chat-git-toggle');
      await expect(gitToggle).toBeVisible({ timeout: WAY_IN_MS });
      if ((await gitToggle.getAttribute('data-open')) !== 'true') await gitToggle.click();
      await expect(page.getByTestId('git-view')).toBeVisible({ timeout: 60_000 });

      // ---- the swap --------------------------------------------------------
      const transcript = page.getByTestId('transcript');
      const pane = page.getByTestId('git-diff-pane');
      await expect(transcript).toBeVisible();
      await expect(pane).toHaveCount(0);

      const diffToggle = page.getByTestId('git-diff-toggle');
      await expect(diffToggle).toHaveAttribute('aria-pressed', 'false');
      await diffToggle.click();

      await expect(pane).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('git-diff-view')).toBeVisible();
      await expect(diffToggle).toHaveAttribute('aria-pressed', 'true');
      // The conversation is not beside the diff, above it or below it: it has
      // gone, and its box is still there holding the reader's place.
      await expect(transcript, 'the conversation was still on screen beside the diff').toBeHidden();

      // ---- one section per change, in git's own order ----------------------
      const files = page.getByTestId('git-diff-file');
      await expect(files).toHaveCount(6, { timeout: 60_000 });
      expect(
        await files.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-path'))),
        'the diff did not name exactly the six files this repository changed',
      ).toEqual([
        'edited.txt',
        'gone.txt',
        'never-told.txt',
        'now-here.txt',
        'picture.png',
        'staged-new.txt',
      ]);

      const section = (path: string) => page.locator(`[data-testid="git-diff-file"][data-path="${path}"]`);
      const counts = (path: string) => section(path).getByTestId('git-diff-counts');
      // One line rewritten, so one line each way; the rest are what they are.
      await expect(counts('edited.txt')).toHaveText(/\+1\s+−1/);
      await expect(counts('gone.txt')).toHaveText(/\+0\s+−1/);
      await expect(counts('never-told.txt')).toHaveText(/\+2\s+−0/);
      await expect(counts('staged-new.txt')).toHaveText(/\+1\s+−0/);

      // The letter each status gets is the rail's own; the diff borrows it
      // rather than inventing a second alphabet.
      for (const [path, word] of [
        ['edited.txt', 'M'],
        ['gone.txt', 'D'],
        ['never-told.txt', '?'],
        ['now-here.txt', 'R'],
        ['picture.png', 'M'],
        ['staged-new.txt', 'A'],
      ] as const) {
        await expect(section(path), `${path} did not say it was ${word}`).toContainText(word);
      }

      // A picture is not shown as lines, and says so.
      await expect(section('picture.png').getByTestId('git-diff-binary')).toBeVisible();
      // A pure rename has nothing to draw, and says that rather than nothing.
      await expect(section('now-here.txt').getByTestId('git-diff-unchanged')).toBeVisible();
      await expect(section('now-here.txt')).toContainText('was-here.txt');
      await expect(page.getByTestId('git-diff-empty')).toHaveCount(0);

      // ---- the lines themselves, side by side ------------------------------
      const table = section('edited.txt').getByTestId('diff-table');
      await expect(table).toBeVisible();
      // The rewritten line is drawn as one row with both halves on it, and the
      // lines around it are the file's own.
      const kinds = await table
        .locator('tr')
        .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-diff-kind')));
      expect(kinds, 'the rewritten line was not paired as one row').toContain('changed');
      expect(kinds, 'the lines that did not change were not drawn').toContain('same');
      const changed = table.locator('tr[data-diff-kind="changed"]').first();
      await expect(changed).toContainText('two');
      await expect(changed).toContainText('TWO');
      // Both gutters carry the line's number: a diff with one column of
      // numbers is not a side-by-side diff.
      const gutters = await changed
        .locator('td')
        .evaluateAll((cells) => [cells[0]?.textContent?.trim(), cells[2]?.textContent?.trim()]);
      expect(gutters, 'the paired row was missing a number on one side').toEqual(['2', '2']);
      // A file deleted is all removals; a file added is all additions.
      await expect(section('gone.txt').locator('tr[data-diff-kind="removed"]').first()).toBeVisible();
      await expect(section('staged-new.txt').locator('tr[data-diff-kind="added"]').first()).toBeVisible();

      await page.screenshot({ path: `${SHOTS}/bw-rx1y-diff-open.png` });

      // ---- a section shut on its lines -------------------------------------
      const shut = section('never-told.txt');
      await expect(shut).toHaveAttribute('data-open', 'true');
      await shut.getByTestId('git-diff-file-toggle').click();
      await expect(shut).toHaveAttribute('data-open', 'false');
      await expect(shut.getByTestId('diff-table')).toHaveCount(0);
      // Shut on its lines and not on itself: it is still a line to read and
      // still says how much changed.
      await expect(shut.getByTestId('git-diff-counts')).toBeVisible();
      // The chevron turns back over about a sixth of a second.
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/bw-rx1y-file-collapsed.png` });

      // ---- the file's name is the way into an editor -----------------------
      const named = section('edited.txt').getByTestId('path-chip').first();
      await expect(named).toHaveAttribute('data-path-target', 'editor');
      await expect(named).toHaveAttribute('data-path-line', '1');
      await named.click();
      await expect
        .poll(() => asked.length, { message: 'clicking the file name asked nothing to open it' })
        .toBe(1);
      expect(asked[0]).toMatchObject({ path: join(REPO, 'edited.txt'), target: 'vscode', line: 1 });
      // And the click that opened the file did not also shut the section its
      // name was sitting on.
      await expect(section('edited.txt')).toHaveAttribute('data-open', 'true');

      // ---- the act: a shell, while the diff is on screen --------------------
      // Nothing between here and the assertion touches the page.
      writeFileSync(join(REPO, 'edited.txt'), EDITED_BY_A_SHELL);
      expect(git(REPO, 'diff', '--numstat', '--', 'edited.txt'), 'the edit did not land').toContain('2\t2');

      await expect(
        counts('edited.txt'),
        'a file edited from a shell never reached the diff on screen',
      ).toHaveText(/\+2\s+−2/, { timeout: SHELL_EDIT_MS });
      await expect(section('edited.txt').locator('tr[data-diff-kind="changed"]')).toHaveCount(2);

      // ---- and the conversation comes back ----------------------------------
      await diffToggle.click();
      await expect(transcript, 'the conversation did not come back').toBeVisible({ timeout: 30_000 });
      await expect(pane).toHaveCount(0);
      await expect(diffToggle).toHaveAttribute('aria-pressed', 'false');
      await page.screenshot({ path: `${SHOTS}/bw-rx1y-back-to-chat.png` });

      // Taking the rail off Git is the same answer: the reader put the whole
      // subject away, and must not have to remember a switch two panels deep.
      await diffToggle.click();
      await expect(pane).toBeVisible({ timeout: 30_000 });
      await gitToggle.click();
      await expect(page.getByTestId('git-view')).toHaveCount(0);
      await expect(pane).toHaveCount(0);
      await expect(transcript, 'shutting Git left the conversation away').toBeVisible();

      // ---- and the choice is the reader's, not the page's -------------------
      await page.reload();
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
      await expect(page.getByTestId('transcript')).toBeVisible({ timeout: 60_000 });
      await page.getByTestId('chat-git-toggle').click();
      await expect(
        page.getByTestId('git-diff-pane'),
        'the diff was forgotten over a reload',
      ).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('git-diff-toggle')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
