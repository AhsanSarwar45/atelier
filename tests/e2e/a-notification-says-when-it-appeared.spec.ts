import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A notification says when it appeared, and says the same thing tomorrow
 * (bw-zvgc).
 *
 * The tray said what a chat wanted and never when it started wanting it, so a
 * chat that stopped a minute ago and one that stopped last night read exactly
 * alike. Nothing was writing that moment down either, so there was nothing the
 * page could have drawn even if it had wanted to.
 *
 * The moment is the server's, recorded in `workbench.db` the moment a chat
 * reaches a state worth announcing. That is what this case drives: a real chat
 * asks a real question, and the row that appears carries a clock time — then a
 * second tab, which never saw that moment happen, is handed the identical
 * time. A row that worked the time out for itself would have said "just now"
 * in both tabs and been wrong in the second one an hour later.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-notification-says-when-it-appeared.spec.ts
 */

const SHOTS = 'tests/results/a-notification-says-when';
const WAY_IN_MS = 120_000;
const FIXTURE = join(__dirname, '..', '.says-when-run');
const REPO = join(FIXTURE, 'repo');
const PHONE = { width: 390, height: 844 };

/** What the tray writes for something that appeared today: a clock and nothing else. */
const A_CLOCK = /^\d{1,2}:\d{2}(\s?[AP]M)?$/i;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', '--local', 'user.name', 'Says When Fixture');
  git(REPO, 'config', '--local', 'user.email', 'says-when@example.invalid');
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "says-when"',
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
    data: { name: 'says-when', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/** A test project is left out of both the project list and the tray; ask for it back. */
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

test.describe('a notification', () => {
  test.describe.configure({ timeout: 300_000, mode: 'serial' });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('says when it appeared, and says it the same way in the next tab', async ({ page, request }) => {
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

      const when = page.getByTestId('tray-when');
      await expect(when, 'the row said nothing about when it appeared').toHaveCount(1);
      const said = ((await when.textContent()) ?? '').trim();
      expect(said, 'a time that is not a clock time').toMatch(A_CLOCK);
      await shoot(page, '1-when-it-appeared');

      /*
        A second tab, which was not open when the chat asked its question and
        so has nothing of its own to go on. It gets the moment from the server,
        so it must read the identical clock time rather than the time it opened.
      */
      const next = await page.context().newPage();
      try {
        await showTestProjects(next);
        await next.setViewportSize(PHONE);
        await next.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
        await next.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
        await next.getByTestId('tray-badge').click();
        await expect(next.getByTestId('tray-panel')).toBeVisible();
        await shoot(next, '2-the-same-time-in-the-next-tab');
        await expect(
          next.getByTestId('tray-when'),
          'a tab that never saw the chat ask timed the row from its own arrival',
        ).toHaveText(said);
      } finally {
        await next.close();
      }
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
