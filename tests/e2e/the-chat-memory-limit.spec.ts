import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The limit a chat is held to, and what happens to a chat that goes over it
 * (bw-qg8r.1).
 *
 * Both cases own the one limit the whole server holds, so they live in one
 * file and run one at a time — `fullyParallel` would otherwise have them
 * setting and clearing it underneath each other.
 *
 * The second case is the behaviour. The scripted agent is made to spawn a child holding far more than the limit
 * allows. That child is a grandchild of the app, not the agent itself, because
 * the claim is that a chat is charged for everything below it — its provider,
 * its subagents and its shells. The watcher has to see the whole tree, stop it,
 * and then restart the chat by sending it the bill.
 *
 * Run:
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" \
 *   BEADS_E2E_MEMORY_HOG=900 \
 *   BEADS_E2E_MEMORY_MARKER="$PWD/tests/.memory-limit-run/hogged" \
 *   scripts/workbench-e2e.sh tests/e2e/the-chat-memory-limit.spec.ts
 */

const SHOTS = 'tests/results/memory-limit';
const FIXTURE = join(__dirname, '..', '.memory-limit-run');
const REPO = join(FIXTURE, 'over-the-limit');
const PROJECT = 'Memory limit';
/** Long enough for two samples three seconds apart, and for a relaunch. */
const WAY_IN_MS = 120_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function seedRepository(): void {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', '--local', 'user.name', 'Memory Limit Fixture');
  git(REPO, 'config', '--local', 'user.email', 'memory@example.invalid');
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    ['schema_version = 1', '', '[project]', `display_name = "${PROJECT}"`, 'use_beads = false', '', '[git]', 'completed_work_branch = "main"', ''].join('\n'),
  );
  writeFileSync(join(REPO, 'alpha.txt'), 'start\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'start');
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as { id: string; path: string }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', { data: { name: PROJECT, path: REPO, isTest: true } });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/** The fixture project is a test project, and the answers this needs hide those. */
async function showTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/(projects|workbench\/notifications)(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

test.describe('the chat memory limit', () => {
  test.describe.configure({ timeout: 300_000, mode: 'serial' });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('is set on the settings screen, survives a reload, and can be cleared', async ({ page, request }) => {
    // Both cases in this file own the one limit the whole server holds, which
    // is why they are here together and run one at a time.
    await request.put('/api/settings/memory', { data: { limitGb: null } });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/settings?section=memory');
    const field = page.getByTestId('memory-limit');
    await expect(page.getByTestId('memory-settings')).toBeVisible();

    // Nobody has set one: the field is empty and says so.
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('placeholder', 'No limit');
    await page.screenshot({ path: `${SHOTS}/no-limit.png` });

    await field.fill('8');
    await field.blur();
    await expect(field).toHaveValue('8');

    await page.reload();
    await expect(page.getByTestId('memory-limit')).toHaveValue('8');
    await page.screenshot({ path: `${SHOTS}/limit-set.png` });

    // The server holds it, not the browser.
    expect(await (await request.get('/api/settings/memory')).json()).toEqual({ limitGb: 8 });

    // A limit no chat could ever start under is refused, and the old one stands.
    const refused = await request.put('/api/settings/memory', { data: { limitGb: 0.01 } });
    expect(refused.status()).toBe(422);
    expect(await (await request.get('/api/settings/memory')).json()).toEqual({ limitGb: 8 });

    // Emptying the field is how a limit is taken off again.
    await page.getByTestId('memory-limit').fill('');
    await page.getByTestId('memory-limit').blur();
    await page.reload();
    await expect(page.getByTestId('memory-limit')).toHaveValue('');
    expect(await (await request.get('/api/settings/memory')).json()).toEqual({ limitGb: null });
  });

  test('is stopped, and the chat that comes back is told what it spent', async ({ page, request }) => {
    test.skip(
      !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'),
      'needs the scripted ACP agent; run with BEADS_E2E_ACP_ADAPTERS=$PWD/tests/fixtures/acp-adapters',
    );
    test.skip(!process.env.BEADS_E2E_MEMORY_HOG, 'needs an agent that holds too much; set BEADS_E2E_MEMORY_HOG');
    await showTestProjects(page);

    const set = await request.put('/api/settings/memory', { data: { limitGb: 0.5 } });
    expect(set.ok(), await set.text()).toBe(true);
    expect(await set.json()).toEqual({ limitGb: 0.5 });

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

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });

      // Starting the agent is what spawns the child that holds too much.
      const sent = await request.post('/api/workbench/command', {
        data: { type: 'prompt.send', sessionId, text: 'read alpha.txt' },
      });
      expect(sent.ok(), await sent.text()).toBe(true);

      // Two samples three seconds apart, then the chat is stopped and the bill
      // is what starts it again. The bill is an ordinary message, so it is
      // there for a reader who has hidden nothing and for one who has.
      const bill = page.getByText('Your run was stopped because it went over the memory limit', { exact: false });
      await expect(bill).toBeVisible({ timeout: WAY_IN_MS });
      // Each paragraph of the bill is a row of its own.
      await expect(page.getByText('against a limit of 512 MB', { exact: false })).toBeVisible();
      await expect(page.getByText('do not run it the same way again', { exact: false })).toBeVisible();

      // The app's own notes are off by default and folded when they are on
      // (machine-lines.ts). Switched on and opened, they say in one line why
      // the chat stopped.
      await page.getByTestId('open-kind-filter').click();
      await page.getByTestId('show-every-kind').click();
      await page.keyboard.press('Escape');
      const notes = page.getByTestId('note-row').filter({ has: page.getByTestId('note-toggle') });
      await expect(notes.first()).toBeVisible({ timeout: 30_000 });
      await notes.first().getByTestId('note-toggle').click();
      const why = page.getByTestId('note-body').filter({ hasText: 'Atelier stopped this chat' });
      await expect(why).toBeVisible({ timeout: 30_000 });

      await why.scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/stopped-and-billed.png`, fullPage: false });

      // The chat is alive again on a process of its own, and nothing under it
      // is still holding what it was stopped for.
      const report = (await (await request.get('/api/workbench/memory')).json()) as {
        chats: { sessionId: string; bytes: number }[];
      };
      const still = report.chats.find((chat) => chat.sessionId === sessionId);
      expect(still?.bytes ?? 0, 'the chat came back without what it was stopped for').toBeLessThan(0.5 * 1024 ** 3);
    } finally {
      await request.put('/api/settings/memory', { data: { limitGb: null } });
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
