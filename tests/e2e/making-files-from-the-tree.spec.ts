import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Files and folders are made from the tree, and copied (bw-5gax.4).
 *
 * The last thing the browser could not do. A reader who has to leave for a
 * terminal to run `touch` is using a file viewer, not a file manager, which is
 * the whole point of this epic.
 *
 * What is proved here is the disk, not the tree: every assertion that something
 * was made reads it back with `node:fs`, and the tree is then checked to have
 * redrawn on its own — nothing in this spec presses refresh, because the folder
 * watch is what is supposed to do that.
 *
 * The refusals are fired at the ROUTE rather than at the menu, for the same
 * reason as the delete spec: a client that does not offer an item is not a
 * guard, since anyone can send the call.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/making-files-from-the-tree.spec.ts
 */

const SHOTS = 'tests/results';
const WAIT = 60_000;

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src'), { recursive: true });
  writeFileSync(join(where, 'README.md'), '# readme\n');
  writeFileSync(join(where, 'src', 'main.ts'), 'export const main = "these bytes";\n');
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

test('a file and a folder are made from the tree, and a file is duplicated', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(__dirname, '..', '.workbench-run-5gax-make');
  const elsewhere = join(__dirname, '..', '.workbench-run-5gax-make-elsewhere');
  rmSync(elsewhere, { recursive: true, force: true });
  mkdirSync(elsewhere, { recursive: true });
  seed(fixture);
  await seeTestProjects(page);
  const project = await fixtureProject(request, 'make-from-tree', fixture);
  const named = (path: string) => page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/${path}"]`);
  const viewer = page.getByTestId('files-viewer');

  /** Right-click a row and pick one of the menu's items. */
  const chooseOn = async (path: string, item: string) => {
    const box = (await named(path).boundingBox())!;
    await page.mouse.click(Math.round(box.x + 40), Math.round(box.y + box.height / 2), { button: 'right' });
    await page.getByTestId('files-tree-menu').waitFor({ timeout: WAIT });
    await page.getByTestId(item).click();
  };

  /** Right-click a row, pick an item that asks for a name, and give it one. */
  const makeOn = async (path: string, item: string, called: string) => {
    await chooseOn(path, item);
    const name = page.getByTestId('path-name');
    await name.waitFor({ timeout: WAIT });
    await name.fill(called);
    await name.press('Enter');
  };

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await expect(page.getByTestId('files-tab')).toHaveAttribute('data-root', fixture, { timeout: WAIT });
    await named('src').click();
    await expect(named('src/main.ts')).toBeVisible({ timeout: WAIT });
    await named('src/main.ts').click();
    await expect(viewer).toHaveAttribute('data-file', `${fixture}/src/main.ts`, { timeout: WAIT });
    await page.screenshot({ path: `${SHOTS}/bw-5gax4-before.png`, animations: 'disabled' });

    // ── A new file, asked for on a FILE, lands beside it and opens ─────────
    await makeOn('src/main.ts', 'path-new-file', 'fresh.ts');
    await expect(page.getByTestId('path-name-dialog')).toBeHidden({ timeout: WAIT });
    expect(existsSync(join(fixture, 'src', 'fresh.ts')), 'the file is not on disk').toBe(true);
    expect(readFileSync(join(fixture, 'src', 'fresh.ts'), 'utf8')).toBe('');
    await expect(named('src/fresh.ts')).toBeVisible({ timeout: WAIT });
    // It opens: an empty file nobody can type into is not a file that was made.
    await expect(viewer).toHaveAttribute('data-file', `${fixture}/src/fresh.ts`, { timeout: WAIT });

    // ── A new folder, asked for on a FOLDER, lands inside it ──────────────
    await makeOn('src', 'path-new-folder', 'helpers');
    await expect(page.getByTestId('path-name-dialog')).toBeHidden({ timeout: WAIT });
    expect(statSync(join(fixture, 'src', 'helpers')).isDirectory()).toBe(true);
    await expect(named('src/helpers')).toBeVisible({ timeout: WAIT });
    // A folder has nothing to look at, so the viewer stays where it was.
    await expect(viewer).toHaveAttribute('data-file', `${fixture}/src/fresh.ts`);

    // ── Duplicate: no dialog, and the copy carries the bytes ──────────────
    await chooseOn('src/main.ts', 'path-duplicate');
    await expect.poll(() => existsSync(join(fixture, 'src', 'main copy.ts')), { timeout: WAIT }).toBe(true);
    expect(readFileSync(join(fixture, 'src', 'main copy.ts'), 'utf8'))
      .toBe('export const main = "these bytes";\n');
    expect(readFileSync(join(fixture, 'src', 'main.ts'), 'utf8'))
      .toBe('export const main = "these bytes";\n');
    await expect(named('src/main copy.ts')).toBeVisible({ timeout: WAIT });
    // Twice, because the second copy has to find a name of its own.
    await chooseOn('src/main.ts', 'path-duplicate');
    await expect.poll(() => existsSync(join(fixture, 'src', 'main copy 2.ts')), { timeout: WAIT }).toBe(true);
    await page.screenshot({ path: `${SHOTS}/bw-5gax4-after.png`, animations: 'disabled' });

    // ── A name already taken is refused, and the file already there is kept ─
    await makeOn('src', 'path-new-file', 'fresh.ts');
    await expect(page.getByText('That could not be created')).toBeVisible({ timeout: WAIT });
    expect(readFileSync(join(fixture, 'src', 'main.ts'), 'utf8'))
      .toBe('export const main = "these bytes";\n');
    await page.keyboard.press('Escape');

    // ── The refusals, at the route ────────────────────────────────────────
    // 403 is "not yours to touch"; 400 is "that is not a name at all", which is
    // where a name carrying a path of its own is stopped — before it is ever
    // joined to a folder, so the jail is never asked a question about it.
    const madeOutside = [
      [403, 'a folder in another tree', { root: fixture, dir: elsewhere, name: 'theirs.txt', kind: 'file' }],
      [
        403,
        'a folder reached by climbing out',
        { root: fixture, dir: join(fixture, 'src', '..', '..'), name: 'theirs.txt', kind: 'file' },
      ],
      [403, "the checkout's own .git", { root: fixture, dir: join(fixture, '.git'), name: 'sneak', kind: 'file' }],
      [400, 'a name that is itself a path', { root: fixture, dir: fixture, name: '../theirs.txt', kind: 'file' }],
      [403, 'a root that is no checkout', { root: elsewhere, dir: elsewhere, name: 'theirs.txt', kind: 'file' }],
    ] as const;
    for (const [refused, what, data] of madeOutside) {
      const answer = await request.post('/api/fs/create', { data });
      expect(answer.status(), `${what} was not refused`).toBe(refused);
    }
    const copiedOutside = await request.post('/api/fs/duplicate', {
      data: { root: fixture, path: join(fixture, '..', '.workbench-run-5gax-make-elsewhere') },
    });
    expect(copiedOutside.status(), 'a duplicate aimed outside was not refused').toBe(403);

    expect(existsSync(join(elsewhere, 'theirs.txt')), 'something was written outside the checkout').toBe(false);
    expect(existsSync(join(fixture, '..', 'theirs.txt'))).toBe(false);
    expect(existsSync(join(fixture, '.git', 'sneak'))).toBe(false);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
