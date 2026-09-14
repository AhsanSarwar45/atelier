import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { writeChatWithHelper } from './fixture-record';

/**
 * A chat held in a worktree git keeps outside the project's folder is on that
 * project's list (bw-ggbj.1).
 *
 * keystone keeps its worktrees in ~/dev/worktrees/keystone/…, nowhere under
 * ~/dev/keystone, and every chat worked in one was missing: the list kept only
 * chats whose folder started with the project's. The fixture puts the worktree
 * beside the project rather than in it, and a second chat in a folder that is
 * no checkout of the project at all, which must stay off the list.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-chat-in-a-worktree-outside-the-project-is-listed.spec.ts
 */

const SHOTS = 'tests/results';
const FIXTURE = join(__dirname, '..', '.workbench-run-outside-tree');
const WAIT = 60_000;

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

async function fixtureProject(
  request: APIRequestContext,
  name: string,
  path: string,
): Promise<{ id: string; path: string }> {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test('a chat in a worktree outside the project folder is listed, a stranger is not', async ({
  page,
  request,
}) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  const project = join(FIXTURE, 'keystone');
  mkdirSync(project, { recursive: true });
  git(project, 'init', '-q', '-b', 'main', '.');
  git(project, 'config', 'user.name', 'Atelier Tester');
  git(project, 'config', 'user.email', 'tester@atelier.test');
  git(project, 'config', 'commit.gpgsign', 'false');
  git(project, 'commit', '-qm', 'seed', '--allow-empty');
  const tree = join(FIXTURE, 'worktrees', 'keystone', 'key-1239');
  git(project, 'worktree', 'add', '-q', tree, '-b', 'key-1239');
  const deep = join(tree, 'apps', 'web');
  mkdirSync(deep, { recursive: true });
  const stranger = join(FIXTURE, 'keystone-old');
  mkdirSync(stranger, { recursive: true });

  const beside = writeChatWithHelper({ cwd: deep, sessionId: randomUUID(), branch: 'key-1239', card: 'bw-ggbj' });
  const elsewhere = writeChatWithHelper({ cwd: stranger, sessionId: randomUUID(), branch: 'main', card: 'bw-ggbj' });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await fixtureProject(request, 'keystone', project);

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.goto(`/project?id=${made.id}&tab=chat`);
    const listed = page.locator(`[data-testid="restore-row"][data-external-id="${beside.sessionId}"]`);
    await listed.waitFor({ timeout: WAIT });
    await expect(listed).toHaveAttribute('data-folder', 'key-1239');
    await expect(
      page.locator(`[data-testid="restore-row"][data-external-id="${elsewhere.sessionId}"]`),
    ).toHaveCount(0);

    await page.screenshot({ path: `${SHOTS}/bw-ggbj1-a-chat-in-a-worktree-outside-the-project.png`, animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${made.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
