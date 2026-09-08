import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';

/**
 * Changing the line of work from the Git rail (bw-ov7a.8).
 *
 * The branch on that panel used to be a word on the screen. Somebody who works
 * in branches could see where he was and nothing else — to move he left the app
 * for a terminal, which is the one thing the panel exists to save him. This
 * drives the real thing: a repository on disk with four branches, the rail
 * opened on it, the picker opened and typed into, a branch chosen, and then git
 * itself asked in that directory which branch is out. A panel that redrew from
 * what it asked for rather than from what git did would fail the last line.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/moving-to-another-branch.spec.ts
 */

const SHOTS = 'tests/results';
const WAY_IN_MS = 120_000;

const FIXTURE = join(__dirname, '..', '.branch-switch-run');
const REPO = join(FIXTURE, 'repo');

/** The one the picker is asked to find by typing, out of four. */
const WANTED = 'feature/logging';

// Twice the pixels: the picker is small, and the evidence is read at the size
// it is looked at.
test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A repository with somewhere to go, and no way for a commit here to reach
 * anybody: its own name and address, no signing, and no global hooks path
 * reaching in.
 */
function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(REPO, { recursive: true });

  git(REPO, 'init', '-q', '-b', 'main', '.');
  git(REPO, 'config', '--local', 'user.name', 'Branch Switch Fixture');
  git(REPO, 'config', '--local', 'user.email', 'branch-switch@example.invalid');
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));

  writeFileSync(join(REPO, 'README.md'), 'A project made by a test.\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-qm', 'the files this project starts with');

  // Enough of them that the list is worth typing at rather than reading.
  for (const branch of [WANTED, 'feature/login', 'release/1.0']) {
    git(REPO, 'branch', branch);
  }
}

/** A project of this case's own, marked as a test so it is swept up after. */
async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', {
    data: { name: 'branch-switch', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('moving to another line of work from the rail', () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  // A test project is off the plain list, which is the list this page reads.
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('finds a branch by typing at it, and git has it out afterwards', async ({ page, request }) => {
    const project = await fixtureProject(request);
    // A chat to open: the way into the Git view is a button on a chat, and
    // driving a real agent to get one would be a test of that agent.
    const chat = aChatSomebodyElseIsIn(REPO, 'Move me onto the logging branch');

    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      const row = page.locator(`[data-testid="restore-row"][data-external-id="${chat.id}"]`);
      await row.waitFor({ timeout: WAY_IN_MS });
      await row.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });

      const rail = page.locator('[data-testid="chat-right-rail"]');
      if ((await rail.getAttribute('data-open')) === 'true') {
        await page.getByTestId('chat-right-rail-toggle').click();
      }
      await page.getByTestId('chat-git-toggle').click();
      await expect(page.getByTestId('git-view')).toBeVisible({ timeout: 30_000 });

      const name = page.getByTestId('git-branch-name');
      await expect(name).toHaveText('main', { timeout: 30_000 });

      // ---- the picker -------------------------------------------------------
      await name.click();
      const search = page.getByTestId('git-branch-name-search');
      await expect(search).toBeVisible();
      await search.fill('log');
      // What typing leaves: the branches whose names carry it, and no others.
      await expect(page.getByRole('option')).toHaveText([WANTED, 'feature/login']);

      await page.getByTestId('git-view').screenshot({
        path: `${SHOTS}/bw-ov7a8-choosing-a-branch.png`,
        animations: 'disabled',
      });

      // ---- the move ---------------------------------------------------------
      await page.getByRole('option', { name: WANTED, exact: true }).click();
      await expect(name).toHaveText(WANTED, { timeout: 30_000 });

      // The one line that cannot be satisfied by drawing: git, in that
      // directory, on whichever branch it is really on.
      expect(git(REPO, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(WANTED);

      await page.getByTestId('git-view').screenshot({
        path: `${SHOTS}/bw-ov7a8-on-the-branch-chosen.png`,
        animations: 'disabled',
      });

      // The state nobody chooses and everybody sees: the list has closed and
      // the focus has come back to the trigger, so the ring is drawn around the
      // name. It has to stand clear of the letters (bw-nizd.1).
      await expect(name).toBeFocused();
      await page.getByTestId('git-branch').screenshot({
        path: `${SHOTS}/bw-nizd1-the-focused-branch.png`,
        animations: 'disabled',
      });
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
