import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The worktree badge (8398b95a): the chat header shows the size of the chat's
 * worktree, opens the project's worktrees, moves the chat and deletes one.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/worktree-badge.spec.ts
 */

const RUN = process.env.WORKBENCH_E2E_RUN ?? join(__dirname, '..', '.e2e-run-worktree');
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

test('the worktree badge lists, moves and deletes worktrees', async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-wt-')));
  const main = join(base, 'main');
  const tree = join(base, 'tree');
  const dirty = join(base, 'dirty');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main', '.');
  git(main, 'config', 'user.name', 'Atelier Tester');
  git(main, 'config', 'user.email', 'tester@atelier.test');
  git(main, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(main, '.atelier'));
  writeFileSync(
    join(main, '.atelier', 'project.toml'),
    'schema_version = 1\n\n[project]\ndisplay_name = "worktree-badge"\nsummary = ""\n',
  );
  writeFileSync(join(main, 'README.md'), 'hello\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'seed');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', '../tree');
  // A few MB in the tree, committed so it stays clean.
  writeFileSync(join(tree, 'big.bin'), Buffer.alloc(5 * 1024 * 1024, 7));
  git(tree, 'add', 'big.bin');
  git(tree, 'commit', '-qm', 'big');
  git(main, 'worktree', 'add', '-q', '-b', 'scratch', '../dirty');
  writeFileSync(join(dirty, 'untracked.txt'), 'not committed\n');

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await request.post('/api/projects', { data: { name: 'worktree-badge', path: main, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };
  const sessionId = 'worktree-badge-chat';

  try {
    mkdirSync(SHOTS, { recursive: true });
    await command(request, {
      type: 'session.open',
      sessionId,
      externalId: `${sessionId}-provider`,
      brand: 'codex',
      projectId: project.id,
      projectPath: project.path,
      cwd: main,
      title: 'Badge chat',
      lastActiveAt: new Date().toISOString(),
    });
    console.log('facts before:', await factsCwd(request, sessionId));

    const listed = (await command(request, { type: 'worktrees.list', projectPath: main })) as {
      trees: Array<{ name: string; bytes: number; dirty: boolean; isMain: boolean; branch: string }>;
    };
    console.log('worktrees.list:', JSON.stringify(listed));

    // Step 1: the badge shows.
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${sessionId}"]`);
    await row.waitFor({ timeout: WAIT });
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('chat-tab')).toHaveAttribute('data-session-id', sessionId, { timeout: WAIT });
    const badge = page.getByTestId('worktree-badge');
    await expect(badge).toBeVisible({ timeout: WAIT });
    await expect(page.getByTestId('memory-badge')).toBeVisible();
    const before = (await badge.innerText()).trim();
    console.log('badge before:', before);
    // The folder chip is the badge: it names the folder, and the sizes are in its list.
    expect(before).toBe('main');
    await expect(badge.getByTestId('chat-folder-chip')).toBeVisible();
    const line = page.getByTestId('chat-status-line');
    await line.screenshot({ path: join(SHOTS, 'header.png') });

    // On a phone the folder chip waits behind the row's toggle.
    await page.setViewportSize({ width: 390, height: 844 });
    // The side panel opened on the wide screen covers a phone; close it as a phone user would.
    const rail = page.getByTestId('chat-right-rail');
    if (await rail.getAttribute('data-open') === 'true') await page.getByTestId('chat-right-rail-toggle').click({ force: true });
    await expect(rail).not.toHaveAttribute('data-open', 'true');
    await expect(badge).toBeHidden();
    await line.screenshot({ path: join(SHOTS, 'phone-collapsed.png') });
    await line.getByRole('button', { name: 'Show all chips' }).click();
    await expect(badge).toBeVisible();
    await expect(page.getByTestId('memory-badge')).toBeVisible();
    await line.screenshot({ path: join(SHOTS, 'phone.png') });
    await line.getByRole('button', { name: 'Show fewer chips' }).click();
    await expect(badge).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 800 });

    // Step 2: the popup.
    await badge.click();
    const popup = page.getByTestId('worktree-popup');
    await expect(popup).toBeVisible();
    const rowOf = (name: string) => popup.locator(`[data-testid="worktree-row"][data-name="${name}"]`);
    await expect(popup.getByTestId('worktree-row')).toHaveCount(3);
    await expect(rowOf('main')).toContainText('This chat');
    await expect(rowOf('main')).toContainText('Badge chat');
    await expect(rowOf('main').getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await expect(rowOf('main').getByRole('button', { name: 'Move here' })).toHaveCount(0);
    await expect(rowOf('tree')).toContainText('feature');
    await expect(rowOf('tree')).toContainText('5 MB');
    await expect(rowOf('tree').getByRole('button', { name: 'Move here' })).toBeVisible();
    await expect(rowOf('tree').getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(rowOf('dirty')).toContainText('Uncommitted changes');
    await expect(rowOf('tree')).not.toContainText('Uncommitted changes');
    await popup.screenshot({ path: join(SHOTS, 'popup.png') });

    // Step 3: move here.
    await rowOf('tree').getByRole('button', { name: 'Move here' }).click();
    await expect.poll(() => factsCwd(request, sessionId), { timeout: WAIT }).toBe(tree);
    await expect(rowOf('tree')).toContainText('This chat', { timeout: WAIT });
    await expect(rowOf('main')).not.toContainText('This chat');
    await expect(badge).toHaveText('tree', { timeout: WAIT });

    // Step 4: delete the dirty worktree.
    await rowOf('dirty').getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByTestId('worktree-delete-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('uncommitted changes will be lost');
    await confirm.screenshot({ path: join(SHOTS, 'confirm.png') });
    await confirm.getByRole('button', { name: 'Delete anyway' }).click();
    await expect(confirm).toBeHidden({ timeout: WAIT });
    await expect.poll(() => existsSync(dirty), { timeout: WAIT }).toBe(false);
    expect(git(main, 'branch', '--list', 'scratch').trim()).toContain('scratch');
    expect(git(main, 'worktree', 'list')).not.toContain(dirty);
    await expect(rowOf('dirty')).toHaveCount(0, { timeout: WAIT });

    expect(errors, 'page errors').toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
