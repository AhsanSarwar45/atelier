import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The project screen's third tab (bw-g3o3.4).
 *
 * The tree and the viewer are separate cards, so what is proved here is the room
 * they will stand in: that `?tab=files` is a destination the address can name,
 * that the trigger is there for a project whether or not it keeps cards, that
 * the picker at the top of the rail offers the project and every worktree beside
 * it, and that the checkout chosen and the width dragged are both still there
 * after a reload. A rail whose width or root reset on refresh is one a reader has
 * to set again every time they come back.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-files-tab-opens-on-a-checkout.spec.ts
 */

const SHOTS = 'tests/results';
const FIXTURE = join(__dirname, '..', '.workbench-run-files-tab');
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

/**
 * Every checkout the picker is offering, once it has stopped growing.
 *
 * The project's own folder is offered before git has answered, so a list read
 * the moment it opens is the fallback rather than the answer.
 */
async function offered(page: Page, atLeast: number): Promise<string[]> {
  await page.getByTestId('files-root').click();
  const rows = page.getByRole('option');
  await expect.poll(() => rows.count(), { timeout: WAIT }).toBeGreaterThanOrEqual(atLeast);
  return rows.allInnerTexts();
}

test('the Files tab opens on a checkout the reader chose, and remembers it', async ({
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
  git(FIXTURE, 'worktree', 'add', '-q', join(FIXTURE, 'worktrees', 'reading-room'), '-b', 'reading-room');

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const project = await fixtureProject(request, 'files-tab', FIXTURE);
  const worktree = join(FIXTURE, 'worktrees', 'reading-room');

  try {
    mkdirSync(SHOTS, { recursive: true });

    // Arriving by address, the way a link into a file would.
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tab').waitFor({ timeout: WAIT });
    await expect(page.getByTestId('tab-files')).toBeVisible();

    // Nothing chosen yet, so it is the project's own checkout.
    await expect.poll(
      () => page.getByTestId('files-tab').getAttribute('data-root'),
      { timeout: WAIT },
    ).toBe(FIXTURE);

    // A board is what a project can opt out of; this fixture keeps no cards, so
    // the Board trigger is absent and Files is still there beside Chat.
    await expect(page.getByTestId('tab-chat')).toBeVisible();
    await expect(page.getByTestId('tab-board')).toHaveCount(0);

    const checkouts = await offered(page, 2);
    expect(checkouts.some((row) => row.includes('files-tab')), `picker offered ${checkouts.join(' | ')}`).toBe(true);
    expect(checkouts.some((row) => row.includes('reading-room')), `picker offered ${checkouts.join(' | ')}`).toBe(true);

    await page.getByRole('option', { name: /reading-room/ }).click();
    await expect.poll(
      () => page.getByTestId('files-tab').getAttribute('data-root'),
      { timeout: WAIT },
    ).toBe(worktree);

    // Dragged wider by hand, from the same handle the chat's rails use.
    const handle = page.getByTestId('left-panel-resizer');
    const before = (await page.getByTestId('files-rail').boundingBox())!.width;
    const grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 120, grip.y + grip.height / 2, { steps: 12 });
    await page.mouse.up();
    const widened = (await page.getByTestId('files-rail').boundingBox())!.width;
    expect(widened, 'the rail did not widen when its handle was dragged').toBeGreaterThan(before + 60);

    await page.screenshot({
      path: `${SHOTS}/bw-g3o34-files-tab.png`,
      animations: 'disabled',
    });

    // The whole point of remembering: come back and it is as it was left.
    await page.reload();
    await page.getByTestId('files-tab').waitFor({ timeout: WAIT });
    await expect.poll(
      () => page.getByTestId('files-tab').getAttribute('data-root'),
      { timeout: WAIT },
    ).toBe(worktree);
    await expect.poll(
      async () => (await page.getByTestId('files-rail').boundingBox())!.width,
      { timeout: WAIT },
    ).toBeCloseTo(widened, 0);

    await page.screenshot({
      path: `${SHOTS}/bw-g3o34-files-tab-after-reload.png`,
      animations: 'disabled',
    });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
