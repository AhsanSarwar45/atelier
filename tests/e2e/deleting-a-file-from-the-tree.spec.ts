import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A file is deleted from the tree, and told where it went (bw-5gax.3).
 *
 * Deleting is the one thing the file browser can do that this app cannot take
 * back, so two things are proved here rather than one. The first is that it
 * WORKS and is honest about itself: the reader is asked before anything moves,
 * the sentence they answer says the file goes to the desktop's Trash rather
 * than being erased, and the row and the file both go.
 *
 * The second is the refusal, and it is proved against the SERVER rather than
 * against the menu. A client that never offers an item is not a guard — anyone
 * can send the call — so a delete aimed at a file outside the checkout is fired
 * straight at the route, four different ways, with the file checked afterwards.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/deleting-a-file-from-the-tree.spec.ts
 */

const SHOTS = 'tests/results';
const WAIT = 60_000;

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src'), { recursive: true });
  mkdirSync(join(where, 'scratch'), { recursive: true });
  writeFileSync(join(where, 'README.md'), '# readme\n');
  writeFileSync(join(where, 'src', 'keep.ts'), 'export const keep = 1;\n');
  writeFileSync(join(where, 'src', 'stale.ts'), 'export const stale = 2;\n');
  writeFileSync(join(where, 'scratch', 'one.txt'), 'one\n');
  writeFileSync(join(where, 'scratch', 'two.txt'), 'two\n');
  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Atelier Tester');
  git(where, 'config', 'user.email', 'tester@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

async function seeTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

test.use({ viewport: { width: 1440, height: 900 } });

test('a file is deleted from the tree, and a delete outside the checkout is refused', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(__dirname, '..', '.workbench-run-5gax-delete');
  // Another checkout entirely, which is what the refusals are aimed at.
  const elsewhere = join(__dirname, '..', '.workbench-run-5gax-elsewhere');
  rmSync(elsewhere, { recursive: true, force: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'theirs.txt'), 'not yours\n');
  seed(fixture);
  await seeTestProjects(page);
  const project = await fixtureProject(request, 'delete-from-tree', fixture);
  const named = (path: string) => page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/${path}"]`);

  /**
   * A dialog that has just closed still holds the page for the length of its
   * exit: the library takes pointer events off the body while it is open and
   * gives them back at the end of the animation. A right-click sent into that
   * gap reaches nothing. This waits for the page to be the reader's again.
   */
  const pageIsBack = async () => {
    await expect
      .poll(() => page.evaluate(() => document.body.style.pointerEvents), { timeout: WAIT })
      .toBe('');
  };

  const askToDelete = async (path: string) => {
    await pageIsBack();
    const box = (await named(path).boundingBox())!;
    await page.mouse.click(Math.round(box.x + 40), Math.round(box.y + box.height / 2), { button: 'right' });
    await page.getByTestId('files-tree-menu').waitFor({ timeout: WAIT });
    await page.getByTestId('path-delete').click();
    await page.getByTestId('path-delete-dialog').waitFor({ timeout: WAIT });
  };

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await expect(page.getByTestId('files-tab')).toHaveAttribute('data-root', fixture, { timeout: WAIT });
    await named('src').click();
    await expect(named('src/stale.ts')).toBeVisible({ timeout: WAIT });

    // ── Asked before anything moves, and told where it goes ───────────────
    await askToDelete('src/stale.ts');
    await expect(page.getByTestId('path-delete-dialog')).toContainText('Trash');
    await expect(page.getByTestId('path-delete-dialog')).toContainText('Nothing is erased');
    await page.screenshot({ path: `${SHOTS}/bw-5gax3-before.png`, animations: 'disabled' });

    // Keeping it keeps it. A confirmation that deletes either way is not one.
    await page.getByTestId('path-delete-cancel').click();
    await expect(page.getByTestId('path-delete-dialog')).toBeHidden({ timeout: WAIT });
    expect(existsSync(join(fixture, 'src', 'stale.ts'))).toBe(true);

    await askToDelete('src/stale.ts');
    await page.getByTestId('path-delete-confirm').click();
    await expect(page.getByTestId('path-delete-dialog')).toBeHidden({ timeout: WAIT });

    // The disk, and the tree, which the folder watch redraws on its own.
    await expect.poll(() => existsSync(join(fixture, 'src', 'stale.ts')), { timeout: WAIT }).toBe(false);
    await expect(named('src/stale.ts')).toHaveCount(0, { timeout: WAIT });
    await expect(named('src/keep.ts')).toBeVisible();
    expect(readFileSync(join(fixture, 'src', 'keep.ts'), 'utf8')).toBe('export const keep = 1;\n');

    // Gone from the checkout is not the claim; the claim on the screen is that
    // it went to the Trash and can be put back. The run has a data home of its
    // own, so the trash it went to is this run's and not the reader's.
    const trash = join(process.env.XDG_DATA_HOME ?? '', 'Trash');
    expect(readFileSync(join(trash, 'files', 'stale.ts'), 'utf8')).toBe('export const stale = 2;\n');
    expect(readFileSync(join(trash, 'info', 'stale.ts.trashinfo'), 'utf8'))
      .toContain(`Path=${join(fixture, 'src', 'stale.ts')}`);
    await page.screenshot({ path: `${SHOTS}/bw-5gax3-after.png`, animations: 'disabled' });

    // ── A folder goes with everything in it ───────────────────────────────
    await askToDelete('scratch');
    await expect(page.getByTestId('path-delete-dialog')).toContainText('everything in it');
    await page.getByTestId('path-delete-confirm').click();
    await expect.poll(() => existsSync(join(fixture, 'scratch')), { timeout: WAIT }).toBe(false);

    // ── The refusal, fired at the route rather than at the menu ───────────
    const outside = [
      ['a plain path in another folder', join(elsewhere, 'theirs.txt')],
      ['a path that climbs out with ..', join(fixture, 'src', '..', '..', '.workbench-run-5gax-elsewhere', 'theirs.txt')],
      ["the checkout's own .git", join(fixture, '.git', 'HEAD')],
      ['the checkout itself', fixture],
    ] as const;
    for (const [what, path] of outside) {
      const answer = await request.post('/api/fs/delete', { data: { root: fixture, path } });
      expect(answer.status(), `${what} was not refused`).toBe(403);
    }
    // And naming the other folder as the root instead: it is no checkout.
    const posing = await request.post('/api/fs/delete', {
      data: { root: elsewhere, path: join(elsewhere, 'theirs.txt') },
    });
    expect(posing.status(), 'a root that is no checkout was accepted').toBe(403);

    expect(readFileSync(join(elsewhere, 'theirs.txt'), 'utf8')).toBe('not yours\n');
    expect(existsSync(join(fixture, '.git', 'HEAD'))).toBe(true);
    expect(existsSync(fixture)).toBe(true);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
