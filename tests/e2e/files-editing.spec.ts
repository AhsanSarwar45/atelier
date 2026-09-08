import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Writing a file from the Files tab, with somebody else writing it too
 * (bw-g3o3.11).
 *
 * bw-g3o3.18 proved the quiet half of this: a file opened from the tree can be
 * typed into and saved, and a change made in a shell while nothing is typed
 * arrives on its own. What no case had driven is the half where the two of them
 * disagree — the reader has typed, the file moves underneath, and the banner
 * asks which of the two versions is meant. That path exists only in a browser
 * with a real socket, a real watch and a real disk behind it, and its two
 * answers do opposite things to what ends up in the file, so both are taken to
 * the disk and read back with node rather than off the page.
 *
 * The other seam here is between the editor and the rail: a save is what makes
 * git's answer about that file wrong, and the tree standing beside the viewer
 * has to catch up on its own.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/files-editing.spec.ts
 */

const SHOTS = 'tests/results';
const FIXTURE = join(__dirname, '..', '.workbench-run-files-editing-seams');
const WAIT = 60_000;
/** A watch, a five-second look at git, and two round trips to the disk. */
const SLOW = 45_000;

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
test.setTimeout(240_000);

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

async function fixtureProject(request: APIRequestContext, path: string) {
  const made = await request.post('/api/projects', { data: { name: 'files-editing-seams', path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

/** A line appended the way anything outside this app appends one. */
function appendFromAShell(file: string, line: string): void {
  execFileSync('sh', ['-c', `printf '%s\\n' ${JSON.stringify(line)} >> ${JSON.stringify(file)}`]);
}

/**
 * Type into a file that is still read-only.
 *
 * The first key goes on its own and the flip is waited for, because that flip is
 * a React render: a burst typed at a read-only view would have every key arrive
 * before the first one had turned it editable.
 */
async function typeIntoTheFile(page: Page, first: string, rest: string): Promise<void> {
  await page.getByTestId('files-viewer').locator('.cm-line').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press(first);
  await expect(page.getByTestId('files-viewer').locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.type(rest, { delay: 20 });
}

test('a file is saved from the tab, and a change underneath it is answered either way', async ({ page, request }) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'src'), { recursive: true });
  const file = join(FIXTURE, 'src', 'jobs.ts');
  writeFileSync(file, SAMPLE);
  git(FIXTURE, 'init', '-q', '-b', 'main', '.');
  git(FIXTURE, 'config', 'user.name', 'Atelier Tester');
  git(FIXTURE, 'config', 'user.email', 'tester@atelier.test');
  git(FIXTURE, 'config', 'commit.gpgsign', 'false');
  git(FIXTURE, 'add', '-A');
  git(FIXTURE, 'commit', '-qm', 'seed');

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const project = await fixtureProject(request, FIXTURE);

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });

    // Opened down the tree, out of a checkout with nothing changed in it.
    const row = (path: string) => page.locator(`[data-testid="files-tree-row"][data-path="${FIXTURE}/${path}"]`);
    await row('src').click({ timeout: WAIT });
    await row('src/jobs.ts').click({ timeout: WAIT });
    await expect.poll(() => page.getByTestId('files-viewer').getAttribute('data-file'), { timeout: WAIT }).toBe(file);
    await expect(page.getByTestId('files-viewer').locator('.cm-content')).toContainText('describeJob', { timeout: WAIT });
    expect(await row('src/jobs.ts').getAttribute('data-status')).toBe(null);

    // ── Typed, saved, and read back off the disk ──────────────────────────
    await typeIntoTheFile(page, 'e', 'xport const WIDTH = 4;\n');
    await expect(page.getByTestId('open-file-dirty')).toBeVisible();
    expect(readFileSync(file, 'utf8'), 'a keystroke reached the disk on its own').not.toContain('WIDTH');

    await page.keyboard.press('Control+s');
    await expect(page.getByTestId('open-file-dirty')).toHaveCount(0, { timeout: WAIT });
    await expect.poll(() => readFileSync(file, 'utf8'), { timeout: SLOW }).toContain('export const WIDTH = 4;');

    // The rail is looking at the same checkout, so it has to notice that the
    // file it is drawing is no longer the one that was committed.
    await expect
      .poll(() => row('src/jobs.ts').getAttribute('data-status'), {
        message: 'the tree never caught up with the save made beside it',
        timeout: SLOW,
      })
      .toBe('modified');
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-saved.png`, animations: 'disabled' });

    // ── Somebody else writes it while there is nothing to lose ────────────
    appendFromAShell(file, '// written from a shell');
    await expect(page.getByTestId('files-viewer').locator('.cm-content')).toContainText('written from a shell', { timeout: SLOW });

    // ── …and while there is: the two are put to the reader ────────────────
    await typeIntoTheFile(page, 'e', 'xport const HEIGHT = 9;\n');
    await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
    appendFromAShell(file, '// and again, mid-sentence');
    await expect(page.getByTestId('file-viewer-outside')).toBeVisible({ timeout: SLOW });
    // Neither side has been thrown away while the question stands.
    await expect(page.getByTestId('files-viewer').locator('.cm-content')).toContainText('HEIGHT');
    await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-changed-underneath.png`, animations: 'disabled' });

    // Keep mine, and the save that follows deliberately writes over theirs.
    await page.getByTestId('file-viewer-keep').click();
    await expect(page.getByTestId('file-viewer-outside')).toHaveCount(0);
    await page.keyboard.press('Control+s');
    await expect(page.getByTestId('open-file-dirty')).toHaveCount(0, { timeout: SLOW });
    await expect.poll(() => readFileSync(file, 'utf8'), { timeout: SLOW }).toContain('export const HEIGHT = 9;');
    expect(readFileSync(file, 'utf8'), 'Keep mine did not write over the line it was told to').not.toContain('and again, mid-sentence');
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-kept.png`, animations: 'disabled' });

    // ── The other answer, which throws the reader's own work away ─────────
    await typeIntoTheFile(page, 'e', 'xport const DEPTH = 1;\n');
    await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
    appendFromAShell(file, '// theirs, and this time it wins');
    await expect(page.getByTestId('file-viewer-outside')).toBeVisible({ timeout: SLOW });
    await page.getByTestId('file-viewer-reload').click();
    const content = page.getByTestId('files-viewer').locator('.cm-content');
    await expect(content).toContainText('theirs, and this time it wins', { timeout: SLOW });
    await expect(content).not.toContainText('DEPTH');
    // Nothing is unsaved afterwards: what is on screen is what is on disk.
    await expect(page.getByTestId('file-viewer-dirty')).toHaveCount(0);
    expect(readFileSync(file, 'utf8')).not.toContain('DEPTH');
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-reloaded.png`, animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
