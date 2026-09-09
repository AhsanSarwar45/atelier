import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A file is renamed from the tree, and what was open follows it (bw-5gax.2).
 *
 * The tree could read a project and never change it. Renaming is the first of
 * the operations that do, and the one with something to carry: a file being
 * renamed is very often the file being read, so it is named in the address, it
 * is in the strip of open files, and its text is in the viewer. A rename that
 * left the reader on "Pick a file" would be a rename nobody used twice.
 *
 * So this proves three things a unit test cannot: the DISK changed (the old
 * name is gone and the new one holds the same bytes), the TREE noticed without
 * anybody refreshing it — the folder watch is what does that, not a bespoke
 * call after the rename — and the VIEWER stayed on the file under its new name.
 * The folder case is here too, because a folder carries everything open inside
 * it and that is the arithmetic most likely to be wrong.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/renaming-a-file-from-the-tree.spec.ts
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
  writeFileSync(join(where, 'src', 'notes.ts'), 'export const kept = "these bytes";\n');
  writeFileSync(join(where, 'src', 'other.ts'), 'export const other = 2;\n');
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

test('a file renamed from the tree keeps the viewer and the address on it', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(__dirname, '..', '.workbench-run-5gax-rename');
  seed(fixture);
  await seeTestProjects(page);
  const project = await fixtureProject(request, 'rename-from-tree', fixture);
  const named = (path: string) => page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/${path}"]`);
  const viewer = page.getByTestId('files-viewer');

  /** Right-click a row, choose Rename, type a name and press Enter. */
  const renameTo = async (path: string, to: string) => {
    const box = (await named(path).boundingBox())!;
    await page.mouse.click(Math.round(box.x + 40), Math.round(box.y + box.height / 2), { button: 'right' });
    await page.getByTestId('files-tree-menu').waitFor({ timeout: WAIT });
    await page.getByTestId('path-rename').click();
    const name = page.getByTestId('path-rename-name');
    await name.waitFor({ timeout: WAIT });
    await name.fill(to);
    await name.press('Enter');
    await expect(page.getByTestId('path-rename-dialog')).toBeHidden({ timeout: WAIT });
  };

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await expect(page.getByTestId('files-tab')).toHaveAttribute('data-root', fixture, { timeout: WAIT });
    await named('src').click();
    await named('src/notes.ts').click();
    await expect(viewer).toHaveAttribute('data-file', `${fixture}/src/notes.ts`, { timeout: WAIT });
    await expect(viewer.locator('.cm-content')).toContainText('these bytes', { timeout: WAIT });
    await page.screenshot({ path: `${SHOTS}/bw-5gax2-before.png`, animations: 'disabled' });

    // ── The file the reader is looking at, renamed ────────────────────────
    await renameTo('src/notes.ts', 'kept.ts');

    // The disk, which is the only thing that actually matters.
    expect(existsSync(join(fixture, 'src', 'notes.ts')), 'the old name is still on disk').toBe(false);
    expect(readFileSync(join(fixture, 'src', 'kept.ts'), 'utf8')).toBe('export const kept = "these bytes";\n');

    // The tree, without anybody refreshing it: the folder watch is what tells it.
    await expect(named('src/kept.ts')).toBeVisible({ timeout: WAIT });
    await expect(named('src/notes.ts')).toHaveCount(0);

    // The viewer and the address followed, and the text is still the file's.
    await expect(viewer).toHaveAttribute('data-file', `${fixture}/src/kept.ts`, { timeout: WAIT });
    await expect.poll(() => new URL(page.url()).searchParams.get('file'), { timeout: WAIT })
      .toBe(`${fixture}/src/kept.ts`);
    await expect(viewer.locator('.cm-content')).toContainText('these bytes', { timeout: WAIT });
    // The strip is the reader's list of what is open; a stale name in it is a
    // tab that opens nothing.
    await expect(page.getByTestId('open-file').filter({ hasText: 'kept.ts' })).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/bw-5gax2-after.png`, animations: 'disabled' });

    // ── A folder renamed carries what is open inside it ───────────────────
    await renameTo('src', 'lib');
    expect(existsSync(join(fixture, 'lib', 'kept.ts'))).toBe(true);
    expect(existsSync(join(fixture, 'src'))).toBe(false);
    await expect(viewer).toHaveAttribute('data-file', `${fixture}/lib/kept.ts`, { timeout: WAIT });
    await expect(viewer.locator('.cm-content')).toContainText('these bytes', { timeout: WAIT });

    // ── A name already taken is refused, and nothing is thrown away ───────
    await named('lib').click();
    await expect(named('lib/other.ts')).toBeVisible({ timeout: WAIT });
    const box = (await named('lib/other.ts').boundingBox())!;
    await page.mouse.click(Math.round(box.x + 40), Math.round(box.y + box.height / 2), { button: 'right' });
    await page.getByTestId('files-tree-menu').waitFor({ timeout: WAIT });
    await page.getByTestId('path-rename').click();
    await page.getByTestId('path-rename-name').fill('kept.ts');
    await page.getByTestId('path-rename-name').press('Enter');
    await expect(page.getByText('That could not be renamed')).toBeVisible({ timeout: WAIT });
    expect(readFileSync(join(fixture, 'lib', 'kept.ts'), 'utf8')).toBe('export const kept = "these bytes";\n');
    expect(existsSync(join(fixture, 'lib', 'other.ts'))).toBe(true);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
