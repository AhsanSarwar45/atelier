import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * On a wide screen the chat list folds away from the button that opens it on a
 * phone, and stays folded after a reload (bw-flq1.1).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-chat-list-collapses-on-desktop.spec.ts
 * SHOT_PREFIX names the pictures, so a run on the old tree can leave "before".
 */

const SHOTS = 'tests/results/chat-list-collapse';
const PREFIX = process.env.SHOT_PREFIX ?? 'after';
const FIXTURE = join(__dirname, '..', '.chat-list-collapse-run');
const REPO = join(FIXTURE, 'repo');
const DESKTOP = { width: 1440, height: 900 };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', '--local', 'user.name', 'Collapse Fixture');
  git(REPO, 'config', '--local', 'user.email', 'collapse@example.invalid');
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "chat-list-collapse"',
      'use_beads = false',
      '',
      '[git]',
      'completed_work_branch = "main"',
      '',
    ].join('\n'),
  );
  writeFileSync(join(REPO, 'readme.txt'), 'hello\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'start');
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', {
    data: { name: 'chat-list-collapse', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string };
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${PREFIX}-${name}.png` });
}

test.describe('the chat list on a wide screen', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('folds away from the bar button and stays folded after a reload', async ({ page, request }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    const project = await fixtureProject(request);

    await page.setViewportSize(DESKTOP);
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const rail = page.getByTestId('chat-rail');
    const toggle = page.getByTestId('chat-rail-toggle');
    await expect(rail, 'the chat list is not beside the conversation').toBeVisible({ timeout: 60_000 });
    await shoot(page, 'open');

    // The old tree drew no button on a wide screen; its picture is the proof.
    if (PREFIX === 'before') {
      await expect(toggle).toBeHidden();
      return;
    }

    await expect(toggle, 'no way to fold the chat list on a wide screen').toBeVisible();
    await toggle.click();
    await expect(rail).toBeHidden();
    await expect(page.getByTestId('left-panel-resizer')).toHaveCount(0);
    await shoot(page, 'collapsed');

    await page.reload();
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    await expect(rail, 'the fold was forgotten on reload').toBeHidden();

    await toggle.click();
    await expect(rail).toBeVisible();
    await shoot(page, 'reopened');
  });
});
