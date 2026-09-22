import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A chat nobody ever named is still called something (bw-altj.7).
 *
 * The complaint came off a phone: a tray of rows reading "Untitled chat ·
 * Unknown project · it stopped with an error". The project half is fixed
 * (bw-altj.4); this is the other half. "Untitled chat" was written into six
 * screens separately, so it was not one decision anywhere — and in a tray it is
 * a row naming nothing the owner can act on.
 *
 * A chat gets its title from its first prompt, so the chats this happens to are
 * the ones that never got that far: started and left, or stopped before they
 * answered. This stages one exactly — a prompt of punctuation, which is no
 * words to take a title from — and then asks the two screens that list chats
 * what they call it. They have to agree, and neither may say "Untitled".
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-nameless-chat-is-still-named.spec.ts
 */

const SHOTS = 'tests/results/naming-a-chat';
const WAY_IN_MS = 120_000;
const FIXTURE = join(__dirname, '..', '.naming-a-chat-run');
/** The folder the chat works in, which is what it is named by when nothing else can. */
const REPO = join(FIXTURE, 'bw-altj-worktree');
/** Deliberately not the folder's name: the row draws both, and they must not be confusable. */
const PROJECT = 'Notifications';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function seedRepository(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(FIXTURE, 'no-hooks'), { recursive: true });
  mkdirSync(join(REPO, '.atelier'), { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', '--local', 'user.name', 'Naming Fixture');
  git(REPO, 'config', '--local', 'user.email', 'naming@example.invalid');
  git(REPO, 'config', '--local', 'commit.gpgsign', 'false');
  git(REPO, 'config', '--local', 'core.hooksPath', join(FIXTURE, 'no-hooks'));
  writeFileSync(
    join(REPO, '.atelier', 'project.toml'),
    ['schema_version = 1', '', '[project]', `display_name = "${PROJECT}"`, 'use_beads = false', '', '[git]', 'completed_work_branch = "main"', ''].join('\n'),
  );
  writeFileSync(join(REPO, '.gitignore'), ['.beads/', '.worktrees/', 'node_modules/', ''].join('\n'));
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

/** The fixture project is a test project, and both answers this needs hide those. */
async function showTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/(projects|workbench\/notifications)(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

test.describe('a chat with no title of its own', () => {
  test.describe.configure({ timeout: 300_000, mode: 'serial' });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('is called the same thing in the tray and on the rail', async ({ page, request }) => {
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

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });

      // Punctuation is no words, so nothing is taken from it for a title. The
      // chat still runs, still stops for an answer, and still has to be called
      // something on both screens that list it.
      const sent = await request.post('/api/workbench/command', {
        data: { type: 'prompt.send', sessionId, text: '...' },
      });
      expect(sent.ok(), await sent.text()).toBe(true);

      const bell = page.getByTestId('tray-badge');
      await expect(bell).toHaveAttribute('data-count', '1', { timeout: WAY_IN_MS });
      await bell.click();
      await expect(page.getByTestId('tray-panel')).toBeVisible();

      const trayRow = page.getByTestId('tray-row').first();
      await expect(trayRow).toContainText('bw-altj-worktree');
      await expect(trayRow, 'the tray still had a row naming nothing').not.toContainText('Untitled');

      // The rail beside it, listing the same chat. The two are separate answers
      // from the server and they have to say the same word.
      const railRow = page.getByTestId('row-name').first();
      await expect(railRow).toHaveText('bw-altj-worktree');

      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/named-by-its-folder.png` });
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
