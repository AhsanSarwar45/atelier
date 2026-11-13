import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The worktree badge on a phone: the folder chip and the row's toggle look
 * like the chips beside them, and the worktree list fits the screen with
 * every button in reach.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/worktree-badge-phone.spec.ts
 */

const RUN = process.env.WORKBENCH_E2E_RUN ?? join(__dirname, '..', '.e2e-run-worktree');
const SHOTS = join(RUN, 'shots');
const WAIT = 60_000;

test.use({ viewport: { width: 1400, height: 900 } });

function git(at: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: at, stdio: 'pipe' }).toString();
}

async function command(request: APIRequestContext, data: Record<string, unknown>): Promise<unknown> {
  const response = await request.post('/api/workbench/command', { data });
  const text = await response.text();
  expect(response.status(), text).toBe(200);
  return JSON.parse(text);
}

test('on a phone the folder chip matches its neighbours and its list fits the screen', async ({ page, request }) => {
  test.setTimeout(180_000);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-wtp-')));
  const main = join(base, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main', '.');
  git(main, 'config', 'user.name', 'Atelier Tester');
  git(main, 'config', 'user.email', 'tester@atelier.test');
  git(main, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(main, '.atelier'));
  writeFileSync(
    join(main, '.atelier', 'project.toml'),
    'schema_version = 1\n\n[project]\ndisplay_name = "worktree-phone"\nsummary = ""\n',
  );
  writeFileSync(join(main, 'README.md'), 'hello\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'seed');
  // Long names and dirty trees make the widest rows.
  for (const name of ['a-rather-long-worktree-name', 'another-long-worktree-name']) {
    git(main, 'worktree', 'add', '-q', '-b', name, `../${name}`);
    writeFileSync(join(base, name, 'untracked.txt'), 'not committed\n');
  }

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await request.post('/api/projects', { data: { name: 'worktree-phone', path: main, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };
  const sessionId = 'worktree-phone-chat';

  try {
    mkdirSync(SHOTS, { recursive: true });
    await command(request, {
      type: 'session.open', sessionId, externalId: `${sessionId}-provider`, brand: 'codex',
      projectId: project.id, projectPath: project.path, cwd: main, title: 'Phone chat',
      lastActiveAt: new Date().toISOString(),
    });
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${sessionId}"]`);
    await row.waitFor({ timeout: WAIT });
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('chat-tab')).toHaveAttribute('data-session-id', sessionId, { timeout: WAIT });
    // The chat list is a wide screen's; open the chat there, then turn into a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    const rail = page.getByTestId('chat-right-rail');
    if (await rail.getAttribute('data-open') === 'true') await page.getByTestId('chat-right-rail-toggle').click({ force: true });
    const line = page.getByTestId('chat-status-line');
    await line.getByRole('button', { name: 'Show all chips' }).click();

    // The folder chip is the button itself, the same height as the RAM chip beside it.
    const badge = page.getByTestId('chat-folder-chip');
    await expect(badge).toBeVisible({ timeout: WAIT });
    const chip = (await badge.boundingBox())!;
    const ram = (await page.getByTestId('memory-badge').boundingBox())!;
    console.log(`chip height ${chip.height}, RAM chip height ${ram.height}`);
    expect(Math.abs(chip.height - ram.height), 'folder chip height differs from the RAM chip').toBeLessThanOrEqual(1);
    // The toggle is a chip too, so it does not make the line taller.
    const toggle = (await line.getByRole('button', { name: 'Show fewer chips' }).boundingBox())!;
    console.log(`toggle height ${toggle.height}`);
    expect(Math.abs(toggle.height - ram.height), 'the toggle is taller than the chips').toBeLessThanOrEqual(1);
    await line.screenshot({ path: join(SHOTS, 'phone-chips.png') });

    // The list fits the screen, and every Delete button is inside it.
    await badge.click();
    const popup = page.getByTestId('worktree-popup');
    await expect(popup).toBeVisible();
    await expect(popup.getByTestId('worktree-row')).toHaveCount(3);
    const box = (await popup.boundingBox())!;
    console.log(`popup ${box.x}..${box.x + box.width} on a 390 wide screen`);
    expect(box.x, 'popup starts off screen').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'popup overflows the screen').toBeLessThanOrEqual(390);
    const deletes = popup.getByRole('button', { name: 'Delete' });
    await expect(deletes).toHaveCount(2);
    for (const button of await deletes.all()) {
      const at = (await button.boundingBox())!;
      expect(at.x + at.width, 'a Delete button is cut off').toBeLessThanOrEqual(box.x + box.width);
    }
    await expect(popup).toHaveCSS('opacity', '1');
    await page.screenshot({ path: join(SHOTS, 'phone-popup.png') });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
