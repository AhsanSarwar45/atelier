import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Clearing the notification tray survives the sitting it was done in (bw-poyg).
 *
 * The complaint this case exists for came off a phone: the owner clears the
 * tray, comes back later, and the same rows are waiting again — chats that
 * stopped with an error days ago, already read, already dismissed. Nothing had
 * changed about those chats, so nothing should have brought them back.
 *
 * What brought them back was where the record of having read them was kept: in
 * the browser, for the tab. A phone throws a tab away the moment it needs the
 * memory and rebuilds it on return, and a record kept for the tab goes with it.
 * The record is the server's now (bw-altj), which is why a second tab knows
 * about a clearing it never saw. This drives that exact shape: clear the tray
 * in one tab, then read the tray in another tab of the same browser — which is
 * what the phone hands back — and the rows must still be gone.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-cleared-tray-stays-cleared.spec.ts
 */

const SHOTS = 'tests/results/cleared-tray';
const WAY_IN_MS = 120_000;
const FIXTURE = join(__dirname, '..', '.cleared-tray-run');
const REPO = join(FIXTURE, 'repo');
const PHONE = { width: 390, height: 844 };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', '--local', 'user.name', 'Cleared Tray Fixture');
  git(REPO, 'config', '--local', 'user.email', 'cleared-tray@example.invalid');
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "cleared-tray"',
      'use_beads = false',
      '',
      '[git]',
      'completed_work_branch = "main"',
      '',
    ].join('\n'),
  );
  writeFileSync(join(REPO, '.gitignore'), ['.beads/', '.worktrees/', 'node_modules/', ''].join('\n'));
  writeFileSync(join(REPO, 'alpha.txt'), 'start\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'start');
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', {
    data: { name: 'cleared-tray', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/**
 * The project this case makes is a test project, and test projects are left out
 * of both answers this case needs: the project list the screen is drawn from,
 * and the notifications the tray says. Each leaves them out for its own good
 * reason, and each takes the same one parameter to ask for them back.
 *
 * The tray's half used to be the project list alone, because the tray did the
 * naming itself out of that list — and a chat it could not name drew a row
 * reading "Unknown project" rather than not drawing at all. The server answers
 * that question now (bw-altj), so this asks the server.
 */
async function showTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/(projects|workbench\/notifications)(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe('a cleared tray', () => {
  test.describe.configure({ timeout: 300_000, mode: 'serial' });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('stays cleared in the next tab the browser hands back', async ({ page, request }) => {
    test.skip(
      !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'),
      'needs the scripted ACP agent; run with BEADS_E2E_ACP_ADAPTERS=$PWD/tests/fixtures/acp-adapters',
    );
    await showTestProjects(page);

    const project = await fixtureProject(request);
    try {
      const started = await request.post('/api/workbench/command', {
        data: {
          type: 'session.start',
          projectId: project.id,
          projectPath: project.path,
          brand: 'claude',
          permissionMode: 'bypassPermissions',
        },
      });
      expect(started.ok(), await started.text()).toBe(true);
      const sessionId = ((await started.json()) as { id: string }).id;

      await page.setViewportSize(PHONE);
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });

      const sent = await request.post('/api/workbench/command', {
        data: { type: 'prompt.send', sessionId, text: 'Ask me which direction to take.' },
      });
      expect(sent.ok(), await sent.text()).toBe(true);

      const bell = page.getByTestId('tray-badge');
      await expect(bell).toHaveAttribute('data-count', '1', { timeout: WAY_IN_MS });
      await bell.click();
      await expect(page.getByTestId('tray-panel')).toBeVisible();
      await shoot(page, '1-a-row-to-read');

      await page.getByTestId('tray-clear').click();
      await expect(page.getByTestId('tray-badge'), 'the bell stayed after clearing').toHaveCount(0);
      await shoot(page, '2-cleared');

      /*
        The next sitting. A second tab of the same browser is what a phone
        hands back after it has thrown the first one away: same profile, same
        origin, same reader — a tab that never saw the clearing happen. The
        chat is in the state it was read in, so the tray owes it nothing.
      */
      const next = await page.context().newPage();
      try {
        await showTestProjects(next);
        await next.setViewportSize(PHONE);
        await next.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
        await next.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
        await next.waitForTimeout(3_000);
        await shoot(next, '3-next-sitting');
        await expect(
          next.getByTestId('tray-badge'),
          'a chat cleared in the last sitting came back unchanged in this one',
        ).toHaveCount(0);
      } finally {
        await next.close();
      }
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
