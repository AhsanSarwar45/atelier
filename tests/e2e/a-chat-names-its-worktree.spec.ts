import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { writeChatWithHelper } from './fixture-record';

/**
 * What a chat says about where it is working (bw-ov7a.4).
 *
 * The chip used to name the folder the chat's own record pointed at, and the
 * branch came from the same record. Both are wrong for the way people work:
 * the chat runs in a worktree, often from a folder inside it, and the record's
 * branch is whatever was true when the line was written. The fixture makes
 * both mistakes possible — the chat sits two folders down inside a worktree,
 * and its record says it is on `main` when git says it is on `reading-room` —
 * so a chip that says `reading-room` can only have asked git.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-chat-names-its-worktree.spec.ts
 */

const SHOTS = 'tests/results';
const FIXTURE = join(__dirname, '..', '.workbench-run-worktree-chip');
const WAIT = 60_000;

// Twice the pixels: the chips are small, and the evidence is read at the size
// it is looked at.
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

test('a chat working inside a worktree names that worktree and its branch', async ({
  page,
  request,
}) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  git(FIXTURE, 'init', '-q', '-b', 'main', '.');
  git(FIXTURE, 'config', 'user.name', 'Atelier Tester');
  git(FIXTURE, 'config', 'user.email', 'tester@atelier.test');
  git(FIXTURE, 'config', 'commit.gpgsign', 'false');
  git(FIXTURE, 'commit', '-qm', 'seed', '--allow-empty');
  const tree = join(FIXTURE, 'worktrees', 'reading-room');
  git(FIXTURE, 'worktree', 'add', '-q', tree, '-b', 'reading-room');
  // Where the chat actually ran: a folder inside the worktree, not its root.
  const deep = join(tree, 'server');
  mkdirSync(deep, { recursive: true });

  const written = writeChatWithHelper({
    cwd: deep,
    sessionId: randomUUID(),
    // What the record claims, which git disagrees with. The chip must say what
    // git says.
    branch: 'main',
    card: 'bw-ov7a',
  });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const project = await fixtureProject(request, 'worktree-chip', FIXTURE);

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const listed = page.locator(
      `[data-testid="restore-row"][data-external-id="${written.sessionId}"]`,
    );
    await listed.waitFor({ timeout: WAIT });

    // The row carries it too, before anybody opens anything.
    await expect(listed).toHaveAttribute('data-folder', 'reading-room');

    await listed.getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: WAIT });

    const folder = page.getByTestId('chat-folder-chip');
    const branch = page.getByTestId('chat-branch-chip');
    await expect(folder).toHaveText('reading-room', { timeout: WAIT });
    await expect(branch).toHaveText('reading-room');
    await expect(branch).toHaveAttribute('data-branch', 'reading-room');

    await page.getByTestId('chat-status-line').screenshot({
      path: `${SHOTS}/bw-ov7a4-a-chat-in-a-worktree.png`,
      animations: 'disabled',
    });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
