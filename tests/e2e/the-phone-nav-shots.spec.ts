import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { aChatSomebodyElseIsIn } from './fixture-held';

/**
 * What the navigation looks like once it fits a phone (bw-rpgh).
 *
 * This case takes pictures rather than measurements: each of the six changes in
 * the job is a thing a reader either sees or does not, and the manager reads
 * them off the shots. It still asserts, because a picture of the wrong screen
 * proves nothing — every step waits for the control it is about to photograph.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-phone-nav-shots.spec.ts
 */

const SHOTS = 'tests/results/phone-nav';
const WAY_IN_MS = 120_000;
const FIXTURE = join(__dirname, '..', '.phone-nav-run');
const REPO = join(FIXTURE, 'repo');
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', '--local', 'user.name', 'Phone Nav Fixture');
  git(REPO, 'config', '--local', 'user.email', 'phone-nav@example.invalid');
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "phone-nav"',
      'use_beads = false',
      '',
      '[git]',
      'completed_work_branch = "main"',
      '',
    ].join('\n'),
  );
  writeFileSync(join(REPO, '.gitignore'), ['.beads/', '.worktrees/', 'node_modules/', ''].join('\n'));
  const body = (tag: string) => Array.from({ length: 30 }, (_, at) => `${tag} line ${at + 1}`).join('\n') + '\n';
  writeFileSync(join(REPO, 'alpha.txt'), body('old'));
  writeFileSync(join(REPO, 'beta.txt'), body('old'));
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'start');
  writeFileSync(join(REPO, 'alpha.txt'), body('new'));
  writeFileSync(join(REPO, 'beta.txt'), body('new'));
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', {
    data: { name: 'phone-nav', path: REPO, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/**
 * Let this file's fixture speak on both screens it has to appear on.
 *
 * The project it makes is a test project, and test projects are left out of
 * both answers these cases need: the project list the screen is drawn from,
 * and the notifications the tray says. The tray's half used to come out of the
 * project list too, because the tray did the naming itself — the server
 * answers that question now (bw-altj), and it hides a test project's chats for
 * the same reason the list hides the project.
 */
async function showTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/(projects|workbench\/notifications)(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

test.describe('the navigation on a phone', () => {
  // Serial: the two cases share one seeded repository and one project, and two
  // workers racing on `beforeAll` tore the fixture out from under each other.
  test.describe.configure({ timeout: 300_000, mode: 'serial' });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('the bar, the chat row menu, and the right column', async ({ page, request }) => {
    await showTestProjects(page);

    const project = await fixtureProject(request);
    const chat = aChatSomebodyElseIsIn(REPO, 'Show me what you changed');

    try {
      // ---- 1. the bar on a phone: one hamburger, no pair of buttons --------
      await page.setViewportSize(PHONE);
      const listed = page.waitForResponse((r) => r.url().includes('/api/workbench/restore') && r.ok(), {
        timeout: WAY_IN_MS,
      });
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await listed;
      await expect(page.getByTestId('shell-menu')).toBeVisible({ timeout: WAY_IN_MS });
      await expect(
        page.getByTestId('open-terminal'),
        'the pair belongs above the md break only',
      ).toBeHidden();
      await shoot(page, '01-bar-hamburger');

      await page.getByTestId('shell-menu').click();
      await expect(page.getByTestId('shell-menu-terminal')).toBeVisible();
      await expect(page.getByTestId('shell-menu-settings')).toBeVisible();
      await shoot(page, '02-bar-hamburger-open');
      await page.keyboard.press('Escape');

      // ---- 2. a chat row's own menu ---------------------------------------
      await page.getByTestId('chat-rail-toggle').click();
      const row = page.locator(`[data-testid="restore-row"][data-external-id="${chat.id}"]`);
      await row.waitFor({ timeout: WAY_IN_MS });
      await expect(
        page.getByTestId('chat-rail-close'),
        'the chat list sheet must carry no cross',
      ).toHaveCount(0);
      await shoot(page, '03-chat-list-no-cross');

      await row.getByTestId('row-menu').click();
      const menu = page.getByTestId('chat-context-menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByText('Rename…')).toBeVisible();
      await expect(menu.getByText('Copy ID')).toBeVisible();
      await expect(menu.getByText('Close chat')).toBeVisible();
      await shoot(page, '04-chat-row-menu');
      await page.keyboard.press('Escape');

      // ---- 3. the right column, and its two tabs ---------------------------
      await row.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
      await expect(
        page.getByTestId('chat-git-toggle'),
        'the Git button has left the bar',
      ).toHaveCount(0);

      const rail = page.getByTestId('chat-right-rail');
      if ((await rail.getAttribute('data-open')) !== 'true') {
        await page.getByTestId('chat-right-rail-toggle').click();
      }
      await expect(rail).toHaveAttribute('data-open', 'true', { timeout: 60_000 });
      await expect(
        page.getByTestId('chat-right-rail-close'),
        'the right column must carry no cross either',
      ).toHaveCount(0);
      await expect(page.getByTestId('rail-tab-chat')).toBeVisible();
      await expect(page.getByTestId('rail-tab-git')).toBeVisible();
      await shoot(page, '05-right-rail-agents');

      await page.getByTestId('rail-tab-git').click();
      await expect(rail).toHaveAttribute('data-view', 'git', { timeout: 60_000 });
      await expect(page.getByTestId('git-view')).toBeVisible({ timeout: 60_000 });
      await shoot(page, '06-right-rail-git');
      await page.getByTestId('chat-right-rail-scrim').click({ position: { x: 20, y: 400 } });

      // ---- 4. the Files tab's own column, Git alone ------------------------
      await page.goto(`/project?id=${project.id}&tab=files`);
      await page.getByTestId('files-tab').waitFor({ timeout: WAY_IN_MS });
      const door = page.getByTestId('files-right-rail-toggle');
      await expect(door).toBeVisible({ timeout: 60_000 });
      if ((await rail.getAttribute('data-open')) !== 'true') await door.click();
      await expect(rail).toHaveAttribute('data-open', 'true', { timeout: 60_000 });
      await expect(page.getByTestId('rail-tab-git')).toBeVisible();
      await expect(page.getByTestId('rail-tab-chat')).toHaveCount(0);
      await expect(page.getByTestId('git-view')).toBeVisible({ timeout: 60_000 });
      await shoot(page, '07-files-tab-git');

      const panelFile = page
        .locator('[data-testid="git-file"][data-path="beta.txt"]')
        .getByTestId('git-file-name');
      await expect(panelFile).toBeVisible({ timeout: 60_000 });
      await panelFile.click();
      await expect(page.getByTestId('files-diff-pane')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('files-diff-back')).toBeVisible();
      // Both of a phone's sheets are out of the way: the diff is what was
      // asked for, so nothing may be standing over it.
      await expect(page.getByTestId('files-rail')).toHaveAttribute('data-open', 'false');
      await expect(rail).toHaveAttribute('data-open', 'false');
      await expect(page.locator('[data-testid="git-diff-file"][data-path="beta.txt"]')).toBeInViewport();
      await shoot(page, '08-files-tab-diff');

      // ---- 5. and the same screens on a desktop ----------------------------
      await page.setViewportSize(DESKTOP);
      await page.waitForTimeout(800);
      await expect(
        page.getByTestId('open-terminal'),
        'above the md break the pair is back in plain sight',
      ).toBeVisible();
      await expect(page.getByTestId('shell-menu')).toBeHidden();
      // Side by side, which is what a wide screen is for: the column of
      // changes and the diff of the file picked out of it.
      if ((await rail.getAttribute('data-open')) !== 'true') await door.click();
      await expect(rail).toHaveAttribute('data-open', 'true', { timeout: 60_000 });
      await expect(panelFile).toBeVisible({ timeout: 60_000 });
      await panelFile.click();
      await expect(page.getByTestId('files-diff-pane')).toBeVisible({ timeout: 60_000 });
      await shoot(page, '09-files-tab-git-desktop');

      await page.goto(`/project?id=${project.id}&tab=chat&chat=${chat.id}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
      if ((await rail.getAttribute('data-open')) !== 'true') {
        await page.getByTestId('chat-right-rail-toggle').click();
      }
      await expect(rail).toHaveAttribute('data-open', 'true', { timeout: 60_000 });
      await expect(page.getByTestId('rail-tabs')).toBeVisible();
      await shoot(page, '10-chat-rail-desktop');
    } finally {
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  /**
   * The bell, which needs a chat that is really waiting on the reader.
   *
   * There is no way to fixture that off the disk the way a dormant row is
   * fixtured: what waits on you is a live state, so this drives the scripted
   * ACP agent into asking a question and photographs the bar while it does.
   */
  test('the tray is a bell with a count on it', async ({ page, request }) => {
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
      await expect(bell).toHaveAttribute('data-count', '1', { timeout: 120_000 });
      await expect(
        page.getByText('Waiting on you', { exact: true }),
        'the words belong in the label now, not on the bar',
      ).toHaveCount(0);
      await expect(page.getByTestId('tray-count')).toHaveText('1');
      await shoot(page, '11-bell-phone');

      await bell.click();
      await expect(page.getByTestId('tray-panel')).toBeVisible();
      await expect(bell).toHaveAttribute('data-open', 'true');
      await shoot(page, '12-bell-panel-phone');

      // The tray puts itself away when the reader looks somewhere else. It
      // used to sit there: the press went to the page underneath and the only
      // way out was to find the bell a second time (bw-l6hd.1). The press
      // lands on the conversation behind the tray, which is the thing a thumb
      // reaches for and the thing that used to swallow it.
      // Just below where the tray ends, not at the top of the chat: on a phone
      // the panel drops out of the bar over the whole top of the conversation,
      // so a press at the chat's own first corner is a press ON the tray, which
      // Playwright refuses and which would prove nothing if it landed.
      const panel = (await page.getByTestId('tray-panel').boundingBox())!;
      const chat = (await page.getByTestId('chat-tab').boundingBox())!;
      await page.mouse.click(chat.x + 8, panel.y + panel.height + 8);
      await expect(page.getByTestId('tray-panel')).toHaveCount(0);
      await expect(bell).toHaveAttribute('data-open', 'false');
      await shoot(page, '12b-bell-pressed-away-phone');

      // And by key, for a desk. Radix answers both; neither was answered
      // before.
      await bell.click();
      await expect(page.getByTestId('tray-panel')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('tray-panel')).toHaveCount(0);

      await page.setViewportSize(DESKTOP);
      await page.waitForTimeout(800);
      await expect(bell).toBeVisible();
      await shoot(page, '13-bell-desktop');
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
