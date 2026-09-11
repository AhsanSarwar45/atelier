import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { command } from './fixture-held';

/**
 * A branch that is followed by one name and pushed to another (bw-xp12).
 *
 * `remote.origin.push` can send a branch somewhere its upstream never hears
 * about. git itself then reports work as unpushed forever: `git status` counts
 * against the upstream, the upstream is never written, and the count never
 * falls. The owner of this project met it as a panel reading 109 unpushed
 * commits straight after a push that had sent all 109 of them, with no error
 * anywhere, because there was no error — the push had worked.
 *
 * Nothing here is mocked. Two real repositories over a `file://` remote, a
 * real refspec, a real push, and then the header read off the running app.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/git-panel-counts-where-a-push-goes.spec.ts
 */

/** Where a run leaves its proof; not the artifacts folder, which is emptied. */
const SHOTS = 'tests/results';

/** Opening a chat is a file read plus a wake; this is the whole way in. */
const WAY_IN_MS = 120_000;

const FIXTURE = join(__dirname, '..', '.git-push-target-run');
const SHARED = join(FIXTURE, 'shared.git');
const REPO = join(FIXTURE, 'repo');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A repository set up the way the owner's was: the branch is called `ours`, it
 * follows `origin/ours`, and `remote.origin.push` sends it to `main`. Three
 * commits are then made and pushed, so `main` has them and `ours` does not.
 */
function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', SHARED]);
  git(REPO, 'init', '-q', '-b', 'ours');
  git(REPO, 'config', '--local', 'user.name', 'Push Target Fixture');
  git(REPO, 'config', '--local', 'user.email', 'push-target@example.invalid');
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
  git(REPO, 'remote', 'add', 'origin', SHARED);

  writeFileSync(join(REPO, 'kept'), 'one\n');
  git(REPO, 'add', 'kept');
  git(REPO, 'commit', '-qm', 'first');
  // Both names start level, and `ours` is the one the branch follows.
  git(REPO, 'push', '-q', '--set-upstream', 'origin', 'ours');
  git(REPO, 'push', '-q', 'origin', 'ours:main');

  for (let n = 1; n <= 3; n += 1) {
    writeFileSync(join(REPO, 'kept'), `${n}\n`);
    git(REPO, 'commit', '-qam', `work ${n}`);
  }
  // The line that does it, and then a push that honours it: all three commits
  // land on `main`, and `origin/ours` is left three behind for good.
  git(REPO, 'config', '--local', 'remote.origin.push', 'refs/heads/ours:refs/heads/main');
  git(REPO, 'push', '-q');
}

/** What git itself says, which is the number the panel used to repeat. */
function gitCountsAgainstTheUpstream(): string {
  return git(REPO, 'rev-list', '--count', 'origin/ours..HEAD');
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const made = await request.post('/api/projects', { data: { name: 'push-target', path: REPO } });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('a branch pushed somewhere other than it is followed', () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('counts against the branch it is pushed to, and names it', async ({ page, request }) => {
    // The premise: everything is pushed, and git still says three are not.
    expect(
      gitCountsAgainstTheUpstream(),
      'the fixture did not reproduce the drift the case is about',
    ).toBe('3');

    const project = await fixtureProject(request);
    const started = await command(request, {
      type: 'session.start',
      projectId: project.id,
      projectPath: project.path,
      brand: 'claude',
    });
    expect(started.ok, started.body).toBe(true);
    const sessionId = started.said.id!;

    await page.addInitScript(() => {
      localStorage.setItem('workbench.right-rail', '1');
      localStorage.setItem('workbench.git-panel', '1');
    });
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });

    const view = page.getByTestId('git-view');
    await expect(view, 'the rail opened on something other than Git').toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('git-branch-name')).toHaveText('ours', { timeout: 30_000 });

    // The count is of work a push would send, which is none of it.
    await expect(
      page.getByTestId('git-ahead'),
      'the panel repeated git’s count against a ref no push ever writes',
    ).toHaveAttribute('data-count', '0', { timeout: 30_000 });

    // And both names are on the line, so a reader can see why the count is
    // not the one `git status` would have given.
    await expect(page.getByTestId('git-upstream')).toContainText('origin/ours');
    await expect(page.getByTestId('git-push-to')).toContainText('origin/main');

    await page
      .locator('[data-testid="git-branch"]')
      .screenshot({ path: join(SHOTS, 'a-branch-says-where-its-push-goes.png') });
  });
});
