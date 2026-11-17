import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { openGitView } from './open-git-view';

/**
 * A chat whose worktree was deleted outside the app.
 *
 * The Git tab printed "Repository path does not exist: <path>" in red and the
 * chat box stayed open, so the next message would start an agent in a folder
 * that is not there. Both now show one notice that says the worktree was
 * deleted, with Recreate worktree and Move chat.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-chat-whose-worktree-was-deleted.spec.ts
 */

const RUN = process.env.WORKBENCH_E2E_RUN ?? join(__dirname, '..', '.e2e-run-worktree-deleted');
const SHOTS = join(RUN, 'shots');
const WAIT = 60_000;

test.use({ viewport: { width: 1400, height: 900 } });

function git(at: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: at, stdio: 'pipe' }).toString();
}

async function command(request: APIRequestContext, data: Record<string, unknown>): Promise<unknown> {
  const response = await request.post('/api/workbench/command', { data });
  const text = await response.text();
  expect(response.status(), text).toBe(200);
  return JSON.parse(text);
}

async function factsCwd(request: APIRequestContext, id: string): Promise<string | undefined> {
  const response = await request.get(`/api/workbench/session/${id}`);
  const body = (await response.json()) as { cwd?: string; facts?: { cwd?: string } };
  return body.facts?.cwd ?? body.cwd;
}

async function openChat(page: Page, projectId: string, sessionId: string) {
  await page.goto(`/project?id=${projectId}&tab=chat`);
  const row = page.locator(`[data-testid="restore-row"][data-row-key="${sessionId}"]`);
  await row.waitFor({ timeout: WAIT });
  await row.getByTestId('row-name').click();
  await expect(page.getByTestId('chat-tab')).toHaveAttribute('data-session-id', sessionId, { timeout: WAIT });
}

test('a chat whose worktree was deleted offers to recreate it or move the chat', async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-wt-gone-')));
  const main = join(base, 'main');
  const tree = join(main, 'worktrees', 'feature-key-1-a-fix');
  const other = join(main, 'worktrees', 'other');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main', '.');
  git(main, 'config', 'user.name', 'Atelier Tester');
  git(main, 'config', 'user.email', 'tester@atelier.test');
  git(main, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(main, '.atelier'));
  writeFileSync(
    join(main, '.atelier', 'project.toml'),
    'schema_version = 1\n\n[project]\ndisplay_name = "worktree-deleted"\nsummary = ""\n',
  );
  writeFileSync(join(main, 'README.md'), 'hello\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'seed');
  git(main, 'worktree', 'add', '-q', '-b', 'feature/key-1-a-fix', tree);
  git(main, 'worktree', 'add', '-q', '-b', 'other', other);

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await request.post('/api/projects', { data: { name: 'worktree-deleted', path: main, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };
  const sessionId = 'worktree-deleted-chat';

  try {
    mkdirSync(SHOTS, { recursive: true });
    await command(request, {
      type: 'session.open',
      sessionId,
      externalId: `${sessionId}-provider`,
      brand: 'codex',
      projectId: project.id,
      projectPath: project.path,
      cwd: tree,
      title: 'Gone chat',
      lastActiveAt: new Date().toISOString(),
    });
    // Deleted by hand, so git still lists it.
    rmSync(tree, { recursive: true, force: true });

    await openChat(page, project.id, sessionId);

    // The chat box is replaced by the notice.
    const inChat = page.getByTestId('chat-tab').getByTestId('worktree-missing');
    await expect(inChat).toBeVisible({ timeout: WAIT });
    await expect(inChat).toContainText('Worktree deleted');
    await expect(page.getByTestId('composer-frame')).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'chat.png') });

    // The Git tab shows the same notice, not git's error.
    await openGitView(page);
    const inGit = page.getByTestId('chat-right-rail').getByTestId('worktree-missing');
    await expect(inGit).toBeVisible({ timeout: WAIT });
    await expect(page.getByTestId('git-error')).toHaveCount(0);
    await expect(page.getByTestId('chat-right-rail')).not.toContainText('Repository path does not exist');
    await page.screenshot({ path: join(SHOTS, 'git.png') });

    // Recreate puts the worktree back on the branch it had.
    await inChat.getByRole('button', { name: 'Recreate worktree' }).click();
    await expect.poll(() => existsSync(join(tree, 'README.md')), { timeout: WAIT }).toBe(true);
    expect(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/key-1-a-fix');
    await expect(page.getByTestId('worktree-missing')).toHaveCount(0, { timeout: WAIT });
    await expect(page.getByTestId('composer-frame')).toBeVisible({ timeout: WAIT });
    await expect(page.getByTestId('git-error')).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'recreated.png') });

    // Delete it again, and this time move the chat instead.
    git(main, 'worktree', 'remove', '--force', tree);
    await openChat(page, project.id, sessionId);
    const again = page.getByTestId('chat-tab').getByTestId('worktree-missing');
    await expect(again).toBeVisible({ timeout: WAIT });
    await again.getByRole('button', { name: 'Move chat' }).click();
    await page.getByRole('menuitem', { name: 'other' }).click();
    await expect.poll(() => factsCwd(request, sessionId), { timeout: WAIT }).toBe(other);
    await expect(page.getByTestId('worktree-missing')).toHaveCount(0, { timeout: WAIT });
    await expect(page.getByTestId('composer-frame')).toBeVisible({ timeout: WAIT });

    expect(errors, 'page errors').toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('the deleted-worktree notice fits a phone and works from the keyboard', async ({ page, request }) => {
  test.setTimeout(180_000);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-wt-gone-phone-')));
  const main = join(base, 'main');
  // A long name, the way ticket branches are named.
  const tree = join(main, 'worktrees', 'feature-key-2310-external-tool-grades-passed-to-aspen-but-not-shown');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main', '.');
  git(main, 'config', 'user.name', 'Atelier Tester');
  git(main, 'config', 'user.email', 'tester@atelier.test');
  git(main, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(main, '.atelier'));
  writeFileSync(
    join(main, '.atelier', 'project.toml'),
    'schema_version = 1\n\n[project]\ndisplay_name = "worktree-deleted-phone"\nsummary = ""\n',
  );
  writeFileSync(join(main, 'README.md'), 'hello\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'seed');
  git(main, 'worktree', 'add', '-q', '-b', 'feature/key-2310-external-tool-grades-passed-to-aspen-but-not-shown', tree);

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await request.post('/api/projects', { data: { name: 'worktree-deleted-phone', path: main, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };
  const sessionId = 'worktree-deleted-phone-chat';

  try {
    mkdirSync(SHOTS, { recursive: true });
    await command(request, {
      type: 'session.open',
      sessionId,
      externalId: `${sessionId}-provider`,
      brand: 'codex',
      projectId: project.id,
      projectPath: project.path,
      cwd: tree,
      title: 'Gone chat on a phone',
      lastActiveAt: new Date().toISOString(),
    });
    git(main, 'worktree', 'remove', '--force', tree);

    // Opened from the list on a wide screen, then read at phone width.
    await openChat(page, project.id, sessionId);
    await page.setViewportSize({ width: 390, height: 844 });
    // The side panel opened on the wide screen covers a phone; close it as a phone user would.
    const rail = page.getByTestId('chat-right-rail');
    if (await rail.getAttribute('data-open') === 'true') await page.getByTestId('chat-right-rail-toggle').click({ force: true });
    await expect(rail).not.toHaveAttribute('data-open', 'true');
    const notice = page.getByTestId('chat-tab').getByTestId('worktree-missing');
    await expect(notice).toBeVisible({ timeout: WAIT });
    const box = await notice.boundingBox();
    expect(box, 'the notice has a box').not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await expect(notice).toBeInViewport();
    await expect(notice.getByRole('button', { name: 'Recreate worktree' })).toBeInViewport();
    await expect(notice.getByRole('button', { name: 'Move chat' })).toBeInViewport();
    const overflows = await notice.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflows, 'the notice scrolls sideways').toBe(false);
    // The panels slide shut; the picture is of where they come to rest.
    await page.waitForFunction(() => document.getAnimations().every((motion) => motion.playState !== 'running'));
    await page.screenshot({ path: join(SHOTS, 'phone.png') });

    const recreate = notice.getByRole('button', { name: 'Recreate worktree' });
    await recreate.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => existsSync(join(tree, 'README.md')), { timeout: WAIT }).toBe(true);
    await expect(page.getByTestId('worktree-missing')).toHaveCount(0, { timeout: WAIT });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
