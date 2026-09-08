import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Editing a file the reader opened out of the tree, in the app (bw-g3o3.18).
 *
 * The engine was built and proved by bw-g3o3.8, but against a harness of its
 * own: the Files tab's viewer slot was still being furnished at the time, so
 * nobody using the app could type into a file. This is the case that says the
 * joint is closed, and it is deliberately made without a harness — the project
 * screen, the real tree in the rail, the real strip, the real viewer.
 *
 * Three claims, in the order a reader meets them:
 *
 * - A file clicked in the tree can be typed into, and the tab it opened in
 *   wears the unsaved dot and stops being the replaceable preview slot.
 * - Ctrl+S puts the bytes on disk — read back with node, never off the page.
 * - A change made from a shell while nothing is typed arrives on its own.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/editing-a-file-in-the-files-tab.spec.ts
 */

const SHOTS = 'tests/results';
const FIXTURE = join(__dirname, '..', '.workbench-run-files-editing');
const WAIT = 60_000;

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
// A Next page, a git tree, a CodeMirror mount and two round trips to the disk.
test.setTimeout(180_000);

const SAMPLE = `export interface Job {
  readonly id: string;
}

export function describeJob(job: Job): string {
  return \`job \${job.id}\`;
}
`;

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/**
 * Type into a file that is still read-only.
 *
 * The first key goes on its own and the flip is waited for, because that flip
 * is a React render: a burst typed at a read-only view would have every key
 * arrive before the first one had turned it editable.
 */
async function typeIntoTheFile(page: Page, first: string, rest: string) {
  await page.locator('.cm-line').last().click();
  await page.keyboard.press(first);
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.type(rest, { delay: 20 });
}

test('a file opened from the tree is typed into, saved to disk, and reloaded from a shell', async ({ page, request }) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'src'), { recursive: true });
  git(FIXTURE, 'init', '-q', '-b', 'main', '.');
  git(FIXTURE, 'config', 'user.name', 'Atelier Tester');
  git(FIXTURE, 'config', 'user.email', 'tester@atelier.test');
  git(FIXTURE, 'config', 'commit.gpgsign', 'false');
  git(FIXTURE, 'commit', '-qm', 'seed', '--allow-empty');

  const file = join(FIXTURE, 'src', 'jobs.ts');
  writeFileSync(file, SAMPLE);

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const project = await fixtureProject(request, 'files-editing', FIXTURE);

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tab').waitFor({ timeout: WAIT });

    // Open it the way a reader does: down the tree in the rail, one click at a
    // time. Nothing about the address is typed by hand here.
    const folder = page.locator('[data-testid=files-tree-row][data-kind=dir]', { hasText: 'src' }).first();
    await folder.click();
    const row = page.locator(`[data-testid=files-tree-row][data-path="${file}"]`);
    await row.click({ timeout: WAIT });
    await expect.poll(() => page.getByTestId('files-viewer').getAttribute('data-file'), { timeout: WAIT }).toBe(file);
    await expect(page.locator('.cm-content')).toContainText('describeJob', { timeout: WAIT });

    // It arrived in the replaceable slot, read-only, with nothing unsaved.
    const tab = page.locator(`[data-testid=open-file][data-path="${file}"]`);
    await expect(tab).toHaveAttribute('data-preview', 'true');
    await expect(page.getByTestId('file-viewer-edit')).toBeVisible();
    await expect(page.getByTestId('file-viewer-dirty')).toHaveCount(0);

    await typeIntoTheFile(page, 'e', 'xport const WIDTH = 4;\n');

    // The dot lights in both places at once, and the tab is kept: a file being
    // typed into must not be replaced out of the preview slot mid-sentence.
    await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
    await expect(page.getByTestId('open-file-dirty')).toBeVisible();
    await expect(tab).not.toHaveAttribute('data-preview', 'true');
    expect(readFileSync(file, 'utf8')).not.toContain('WIDTH');
    await page.screenshot({ path: join(SHOTS, 'bw-g3o318-unsaved.png'), animations: 'disabled' });

    await page.keyboard.press('Control+s');
    await expect(page.getByTestId('open-file-dirty')).toHaveCount(0, { timeout: WAIT });

    // The claim that matters, made against the disk rather than the page.
    await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 15_000 }).toContain('export const WIDTH = 4;');
    expect(readFileSync(file, 'utf8')).toContain('describeJob');
    await expect(page.getByTestId('file-viewer-dirty')).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'bw-g3o318-saved.png'), animations: 'disabled' });

    // And the other direction: nothing typed, so a change on disk is taken.
    execFileSync('sh', ['-c', `printf '%s\\n' "// written from a shell" >> ${JSON.stringify(file)}`]);
    await expect(page.locator('.cm-content')).toContainText('written from a shell', { timeout: 30_000 });
    await page.screenshot({ path: join(SHOTS, 'bw-g3o318-reloaded.png'), animations: 'disabled' });
  } finally {
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
