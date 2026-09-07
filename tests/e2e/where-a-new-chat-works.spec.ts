import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Where a new chat will work (bw-ov7a.3).
 *
 * The picker reads the project's real checkouts through git, so the fixture is
 * a real repository with a real worktree standing beside it: what the browser
 * draws here is what git said, not a list the test handed it.
 */
const FIXTURE = join(__dirname, '..', '.workbench-run-where-a-chat-works');

// Twice the pixels for the same box: the dialog is 448px wide by design, and
// the evidence has to be readable at the size it is looked at.
test.use({ deviceScaleFactor: 2 });

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

test('a new chat is offered the project, a worktree of it, or one made here', async ({ page, request }) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  git(FIXTURE, 'init', '-q', '-b', 'main', '.');
  git(FIXTURE, 'config', 'user.name', 'Atelier Tester');
  git(FIXTURE, 'config', 'user.email', 'tester@atelier.test');
  git(FIXTURE, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(FIXTURE, 'kept.txt'), 'one\n');
  git(FIXTURE, 'add', '-A');
  git(FIXTURE, 'commit', '-qm', 'seed');
  git(FIXTURE, 'worktree', 'add', '-q', join(FIXTURE, 'worktrees', 'reading-room'), '-b', 'reading-room');

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await request.post('/api/projects', {
    data: { name: 'where-a-chat-works', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  try {
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    const dialog = page.getByTestId('new-chat-provider-dialog');
    await expect(dialog.getByTestId('where-to-work')).toBeVisible();

    // The project itself is named by its own folder, which is what a chat
    // that works there will be called after.
    await expect(dialog.getByTestId('where-project')).toHaveText(/where-a-chat-works/);

    // The worktree standing beside it was read from git and is offered by
    // name, with the branch it is on.
    await dialog.getByTestId('where-existing').click();
    await expect(dialog.getByTestId('where-worktree')).toHaveText(/reading-room/);
    await dialog.screenshot({ path: 'tests/results/bw-ov7a3-a-worktree-that-is-there.png' });

    // And one made here: a name, a branch that follows it until it is typed
    // over, and the branch it starts from.
    await dialog.getByTestId('where-new').click();
    await dialog.getByTestId('where-new-name').fill('writing-room');
    await expect(dialog.getByTestId('where-branch-name')).toHaveValue('writing-room');
    await expect(dialog.getByTestId('where-base')).toHaveText(/main/);
    await expect(dialog.getByTestId('where-missing')).toHaveCount(0);
    await dialog.screenshot({ path: 'tests/results/bw-ov7a3-a-new-worktree.png' });

    // A name another worktree already has is refused where it is typed,
    // rather than after the chat has been asked for.
    await dialog.getByTestId('where-new-name').fill('reading-room');
    await expect(dialog.getByTestId('where-missing')).toHaveText(
      'There is already a worktree called reading-room.',
    );
    await dialog.screenshot({ path: 'tests/results/bw-ov7a3-a-name-already-taken.png' });
    expect(existsSync(join(FIXTURE, 'worktrees', 'writing-room'))).toBe(false);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
