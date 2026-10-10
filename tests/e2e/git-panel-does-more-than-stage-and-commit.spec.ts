import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';

/**
 * What the Git tab does beyond staging and committing (bw-7s0up): a remote
 * added and a branch published, counts on Push and Pull, a staged file
 * discarded, a message generated, a commit undone, a stash, folded sections,
 * branches made and followed, and a merge conflict settled and aborted.
 *
 * The repositories are real and so is git. Only the agent that writes the
 * commit message is stood in for, and only when the run is started with
 * CLAUDE_PATH pointing at tests/e2e/fixtures/fake-commit-agent.mjs; without it
 * the message is typed instead and the rest is the same.
 *
 * Run:
 *   CLAUDE_PATH="$PWD/tests/e2e/fixtures/fake-commit-agent.mjs" \
 *   FAKE_COMMIT_AGENT_LOG="$WORKBENCH_E2E_RUN/commit-agent.log" \
 *   scripts/workbench-e2e.sh tests/e2e/git-panel-does-more-than-stage-and-commit.spec.ts
 */

const SHOTS = 'tests/results/git-panel-more';
const WAY_IN_MS = 120_000;
const FAKE_AGENT = (process.env.CLAUDE_PATH ?? '').endsWith('fake-commit-agent.mjs');
const AGENT_LOG = process.env.FAKE_COMMIT_AGENT_LOG ?? '';

let ROOT = '';
let REPO = '';
let REMOTE = '';
let OTHER = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitAnyway(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args);
  } catch {
    // A merge that stops on a conflict exits nonzero, and that is the point.
  }
}

function settle(at: string): void {
  git(at, 'config', '--local', 'user.name', 'Git Panel Fixture');
  git(at, 'config', '--local', 'user.email', 'git-panel-fixture@example.invalid');
  git(at, 'config', '--local', 'commit.gpgsign', 'false');
  git(at, 'config', '--local', 'core.hooksPath', 'no-hooks-here');
  // Both sides get a commit below, and a bare `git pull` refuses to choose.
  git(at, 'config', '--local', 'pull.rebase', 'true');
}

async function fixtureProject(request: APIRequestContext, path: string): Promise<{ id: string }> {
  const made = await request.post('/api/projects', {
    data: { name: 'git-panel-more', path, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string };
}

async function openTheGitTab(page: Page, projectId: string, chatId: string): Promise<void> {
  const listed = page.waitForResponse((r) => r.url().includes('/api/workbench/restore') && r.ok(), {
    timeout: WAY_IN_MS,
  });
  await page.goto(`/project?id=${projectId}&tab=chat`);
  await listed;
  const row = page.locator(`[data-testid="restore-row"][data-external-id="${chatId}"]`);
  await row.waitFor({ timeout: WAY_IN_MS });
  await row.getByTestId('row-name').click();
  await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
  await expect(page.getByTestId('git-branch')).toBeVisible({ timeout: 30_000 });
}

function fileRow(page: Page, group: string, path: string) {
  return page.getByTestId(group).locator(`[data-testid="git-file"][data-path="${path}"]`);
}

test.describe('the Git tab beyond stage and commit', () => {
  test.describe.configure({ timeout: 420_000, mode: 'serial' });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    // Under home, not under `tests/`: the routes refuse paths outside home.
    ROOT = mkdtempSync(join(homedir(), '.atelier-e2e-git-more-'));
    REPO = join(ROOT, 'project');
    REMOTE = join(ROOT, 'remote.git');
    OTHER = join(ROOT, 'other-clone');
    mkdirSync(REPO);
    mkdirSync(REMOTE);
    git(REMOTE, 'init', '-q', '--bare', '-b', 'main', '.');
    git(REPO, 'init', '-q', '-b', 'main', '.');
    settle(REPO);
    writeFileSync(join(REPO, 'a.txt'), 'one\n');
    git(REPO, 'add', '-A');
    git(REPO, 'commit', '-q', '-m', 'Add a');
  });

  test.afterAll(() => {
    if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
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

  test('the agent that writes commit messages is chosen in Settings and kept', async ({ page }) => {
    await page.goto('/settings?section=git');
    await expect(page.getByTestId('commit-message-settings')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/settings-before.png` });

    await page.getByTestId('commit-message-provider').click();
    await page.getByRole('option', { name: 'Claude' }).click();
    await expect(page.getByTestId('commit-message-provider')).toContainText('Claude');
    await page.getByTestId('commit-message-model').click();
    await expect(page.getByRole('option', { name: 'Default' })).toHaveCount(1);
    await page.getByRole('option', { name: 'Haiku' }).click();
    const named = 'Haiku';
    await expect(page.getByTestId('commit-message-model')).toContainText(named);

    await page.reload();
    await expect(page.getByTestId('commit-message-provider')).toContainText('Claude');
    await expect(page.getByTestId('commit-message-model')).toContainText(named);
    await expect(page.getByTestId('commit-message-effort')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/settings-after.png` });

    // An agent that cannot be run once from the command line is refused.
    const refused = await page.request.put('/api/settings/commit-message', {
      data: { provider: 'local' },
    });
    expect(refused.status()).toBe(422);
  });

  test('a repository is taken from no remote to a settled merge', async ({ page, request }) => {
    const project = await fixtureProject(request, REPO);
    const chat = aChatSomebodyElseIsIn(REPO, 'Work on the project');

    try {
      await openTheGitTab(page, project.id, chat.id);

      // ---- no remote: nothing that needs one -------------------------------
      await expect(page.getByRole('button', { name: 'Add remote' })).toBeVisible();
      for (const gone of ['git-fetch', 'git-pull', 'git-push', 'git-commit-push']) {
        await expect(page.getByTestId(gone), `${gone} is drawn with no remote`).toHaveCount(0);
      }
      await page.screenshot({ path: `${SHOTS}/no-remote.png` });

      await page.getByTestId('git-add-remote').click();
      await expect(page.getByTestId('git-name-dialog')).toContainText('Add remote');
      await page.getByLabel('Remote URL').fill(REMOTE);
      await page.getByRole('button', { name: 'Add', exact: true }).click();

      // ---- a remote, but nothing published yet -----------------------------
      const push = page.getByTestId('git-push');
      await expect(push).toContainText('Publish branch', { timeout: 30_000 });
      await expect(page.getByTestId('git-fetch')).toBeVisible();
      await expect(page.getByTestId('git-pull')).toHaveCount(0);
      expect(git(REPO, 'remote', 'get-url', 'origin')).toBe(REMOTE);
      await page.screenshot({ path: `${SHOTS}/publish-branch.png` });

      await push.click();
      await expect(page.getByTestId('git-pull')).toBeVisible({ timeout: 30_000 });
      await expect(push).toHaveText(/^Push/);
      await expect(page.getByTestId('git-ahead')).toBeHidden();
      expect(git(REMOTE, 'rev-parse', 'main')).toBe(git(REPO, 'rev-parse', 'HEAD'));

      // ---- the counts are on the buttons ------------------------------------
      writeFileSync(join(REPO, 'b.txt'), 'b\n');
      git(REPO, 'add', '-A');
      git(REPO, 'commit', '-q', '-m', 'Add b');
      await expect(page.getByTestId('git-ahead')).toHaveAttribute('data-count', '1', { timeout: 30_000 });
      await expect(push).toHaveText('Push1');
      await expect(page.getByTestId('git-ahead')).toBeVisible();

      git(ROOT, 'clone', '-q', REMOTE, OTHER);
      settle(OTHER);
      writeFileSync(join(OTHER, 'from-elsewhere.txt'), 'elsewhere\n');
      git(OTHER, 'add', '-A');
      git(OTHER, 'commit', '-q', '-m', 'Add a file from elsewhere');
      git(OTHER, 'push', '-q');
      await page.getByTestId('git-fetch').click();
      await expect(page.getByTestId('git-behind')).toHaveAttribute('data-count', '1', { timeout: 30_000 });
      await expect(page.getByTestId('git-pull')).toHaveText(/^Pull1/);
      await page.screenshot({ path: `${SHOTS}/counts-on-buttons.png` });

      await page.getByTestId('git-pull').click();
      await expect(page.getByTestId('git-behind')).toHaveAttribute('data-count', '0', { timeout: 30_000 });
      expect(existsSync(join(REPO, 'from-elsewhere.txt'))).toBe(true);
      await push.click();
      await expect(page.getByTestId('git-ahead')).toHaveAttribute('data-count', '0', { timeout: 30_000 });

      // ---- one Stage all, and a staged file discarded ------------------------
      writeFileSync(join(REPO, 'a.txt'), 'one\ntwo\n');
      writeFileSync(join(REPO, 'notes.md'), 'Release notes.\n');
      writeFileSync(join(REPO, 'scrap.txt'), 'not wanted\n');
      await expect(fileRow(page, 'git-untracked', 'scrap.txt')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Stage all' })).toHaveCount(1);
      await page.getByRole('button', { name: 'Stage all' }).click();
      await expect(page.getByTestId('git-staged')).toHaveAttribute('data-count', '3', { timeout: 30_000 });

      await fileRow(page, 'git-staged', 'scrap.txt').getByTestId('git-discard-staged').click();
      await expect(page.getByTestId('git-confirm-dialog')).toContainText('The file will be deleted');
      await page.getByTestId('git-confirm').click();
      await expect(page.getByTestId('git-staged')).toHaveAttribute('data-count', '2', { timeout: 30_000 });
      expect(existsSync(join(REPO, 'scrap.txt')), 'the discarded file is still on disk').toBe(false);

      // ---- a message, generated or typed, committed from the keyboard --------
      const box = page.getByTestId('git-commit-message');
      let subject = 'Add the release notes';
      if (FAKE_AGENT) {
        await page.getByRole('button', { name: 'Generate message' }).click();
        await expect(box).toHaveValue(subject, { timeout: 60_000 });
        if (AGENT_LOG) {
          const called = JSON.parse(readFileSync(AGENT_LOG, 'utf8').trim().split('\n').pop()!) as {
            argv: string[];
            prompt: string;
          };
          expect(called.argv.join(' '), 'the model chosen in Settings was not passed').toContain(
            '--model haiku',
          );
          expect(called.prompt).toContain('notes.md');
          expect(called.prompt).toContain('+Release notes.');
        }
      } else {
        subject = 'Add the release notes by hand';
        await box.fill(subject);
      }
      await page.screenshot({ path: `${SHOTS}/message-and-actions.png` });
      await box.press('Control+Enter');
      await expect(page.getByTestId('git-ahead')).toHaveAttribute('data-count', '1', { timeout: 30_000 });
      expect(git(REPO, 'log', '-1', '--format=%s')).toBe(subject);

      // ---- undone: the changes stay staged and the message comes back --------
      await page.getByRole('button', { name: 'Undo last commit' }).click();
      const asking = page.getByTestId('git-confirm-dialog');
      await expect(asking).toContainText('Its changes stay staged');
      await expect(asking).not.toContainText('pushed');
      await page.getByTestId('git-confirm').click();
      await expect(page.getByTestId('git-staged')).toHaveAttribute('data-count', '2', { timeout: 30_000 });
      await expect(box).toHaveValue(subject);
      expect(git(REPO, 'log', '-1', '--format=%s')).toBe('Add b');

      // ---- commit and push in one press --------------------------------------
      await page.getByRole('button', { name: 'Commit and push' }).click();
      await expect(page.getByTestId('git-clean')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('git-ahead')).toHaveAttribute('data-count', '0', { timeout: 30_000 });
      expect(git(REMOTE, 'log', '-1', '--format=%s', 'main')).toBe(subject);

      // A pushed commit is said to be pushed before it is undone.
      await page.getByRole('button', { name: 'Undo last commit' }).click();
      await expect(asking).toContainText('already pushed');
      await page.getByTestId('git-confirm-cancel').click();

      // ---- stash and pop ------------------------------------------------------
      writeFileSync(join(REPO, 'a.txt'), 'one\ntwo\nthree\n');
      writeFileSync(join(REPO, 'loose.txt'), 'loose\n');
      await expect(fileRow(page, 'git-untracked', 'loose.txt')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Stash', exact: true }).click();
      await expect(page.getByTestId('git-clean')).toBeVisible({ timeout: 30_000 });
      const pop = page.getByTestId('git-pop-stash');
      await expect(pop).toHaveAttribute('data-count', '1');
      expect(existsSync(join(REPO, 'loose.txt')), 'the untracked file was not stashed').toBe(false);
      await page.screenshot({ path: `${SHOTS}/stashed.png` });
      await pop.click();
      await expect(fileRow(page, 'git-untracked', 'loose.txt')).toBeVisible({ timeout: 30_000 });
      await expect(fileRow(page, 'git-unstaged', 'a.txt')).toBeVisible();
      await expect(pop).toHaveCount(0);

      // ---- sections fold, and stay folded over a reload -----------------------
      const changes = page.getByTestId('git-unstaged');
      await changes.getByTestId('git-section-toggle').click();
      await expect(changes.getByTestId('git-file')).toHaveCount(0);
      await page.getByTestId('git-history-toggle').click();
      await expect(page.getByTestId('git-history')).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/folded.png` });
      await page.reload();
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
      await expect(changes.getByTestId('git-section-toggle')).toHaveAttribute('aria-expanded', 'false', {
        timeout: 30_000,
      });
      await expect(changes.getByTestId('git-file')).toHaveCount(0);
      await expect(page.getByTestId('git-history')).toHaveCount(0);
      await changes.getByTestId('git-section-toggle').click();
      await page.getByTestId('git-history-toggle').click();
      await expect(page.getByTestId('git-history')).toBeVisible();
      await expect(fileRow(page, 'git-unstaged', 'a.txt')).toBeVisible();

      // ---- a branch made, and a remote one followed ----------------------------
      git(REPO, 'checkout', '-q', '--', '.');
      git(REPO, 'clean', '-fdq');
      await expect(page.getByTestId('git-clean')).toBeVisible({ timeout: 30_000 });
      const picker = page.getByTestId('git-branch-name');
      await picker.click();
      await page.getByTestId('git-branch-name-search').fill('topic');
      await page.screenshot({ path: `${SHOTS}/branch-picker.png` });
      await page.getByTestId('git-branch-name-action').click();
      await expect(page.getByTestId('git-name-dialog')).toContainText('Create branch');
      await expect(page.getByTestId('git-name-field')).toHaveValue('topic');
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(picker).toContainText('topic', { timeout: 30_000 });
      expect(git(REPO, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('topic');

      git(OTHER, 'push', '-q', 'origin', 'main:from-the-remote');
      await page.getByTestId('git-fetch').click();
      await expect
        .poll(() => git(REPO, 'branch', '-r'), { timeout: 30_000 })
        .toContain('origin/from-the-remote');
      // The list is read again when the panel is; ask for that.
      await page.getByTestId('git-refresh').click();
      await page.reload();
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
      await expect(picker).toContainText('topic', { timeout: 30_000 });
      await picker.click();
      await page.getByRole('option', { name: /origin\/from-the-remote/ }).click();
      await expect(picker).toContainText('from-the-remote', { timeout: 30_000 });
      expect(git(REPO, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('from-the-remote');
      expect(git(REPO, 'rev-parse', '--abbrev-ref', 'from-the-remote@{upstream}')).toBe(
        'origin/from-the-remote',
      );

      // ---- a merge that stops: one side taken, then the whole thing given up ----
      git(REPO, 'checkout', '-q', '-b', 'side');
      writeFileSync(join(REPO, 'a.txt'), 'side\n');
      git(REPO, 'commit', '-q', '-am', 'Change a on the side');
      git(REPO, 'checkout', '-q', 'from-the-remote');
      writeFileSync(join(REPO, 'a.txt'), 'ours\n');
      git(REPO, 'commit', '-q', '-am', 'Change a here');
      gitAnyway(REPO, 'merge', 'side');

      const conflict = fileRow(page, 'git-conflicted', 'a.txt');
      await expect(conflict).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Abort merge' })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/conflict.png` });

      await page.getByRole('button', { name: 'Accept incoming change in a.txt' }).click();
      await expect(page.getByTestId('git-conflicted')).toHaveCount(0, { timeout: 30_000 });
      expect(readFileSync(join(REPO, 'a.txt'), 'utf8')).toBe('side\n');

      await page.getByRole('button', { name: 'Abort merge' }).click();
      await page.getByTestId('git-confirm').click();
      await expect(page.getByTestId('git-clean')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('git-abort')).toHaveCount(0);
      expect(readFileSync(join(REPO, 'a.txt'), 'utf8')).toBe('ours\n');
      expect(existsSync(join(REPO, '.git', 'MERGE_HEAD'))).toBe(false);

      await expect(page.getByTestId('git-error')).toHaveCount(0);
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  test('a repository with no commit has nothing to amend or undo', async ({ page, request }) => {
    const fresh = join(ROOT, 'fresh');
    mkdirSync(fresh);
    git(fresh, 'init', '-q', '-b', 'main', '.');
    settle(fresh);
    writeFileSync(join(fresh, 'first.txt'), 'first\n');
    const project = await fixtureProject(request, fresh);
    const chat = aChatSomebodyElseIsIn(fresh, 'Start here');

    try {
      await openTheGitTab(page, project.id, chat.id);
      await expect(fileRow(page, 'git-untracked', 'first.txt')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('git-commit')).toBeVisible();
      await expect(page.getByTestId('git-amend')).toHaveCount(0);
      await expect(page.getByTestId('git-undo-commit')).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/no-commits.png` });

      // The first commit brings both.
      await page.getByRole('button', { name: 'Stage all' }).click();
      await page.getByTestId('git-commit-message').fill('The first commit');
      await page.getByTestId('git-commit').click();
      await expect(page.getByTestId('git-amend')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('git-undo-commit')).toBeVisible();
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
