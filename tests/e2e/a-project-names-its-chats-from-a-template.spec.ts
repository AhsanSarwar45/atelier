import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A project names its chats from a template it arranges (bw-mv45).
 *
 * The manager works in one worktree per ticket and wants every chat to say
 * which ticket it is for. This stages two chats in a ticket's worktree, lays
 * down the "ticket key from worktree" template in the project's settings, and
 * then reads the rail: the chat nobody named is called by the key the
 * template found, and the one the owner renamed keeps the owner's words.
 *
 * Run: BEADS_E2E_ACP_ADAPTERS=$PWD/tests/fixtures/acp-adapters \
 *   scripts/workbench-e2e.sh tests/e2e/a-project-names-its-chats-from-a-template.spec.ts
 */

const SHOTS = 'tests/results/chat-name-template';
const WAY_IN_MS = 120_000;
const FIXTURE = join(__dirname, '..', '.chat-name-template-run');
const REPO = join(FIXTURE, 'keystone');
/** A ticket's worktree: the key the template picks out, and words it must leave behind. */
const WORKTREE = join(REPO, 'worktrees', 'key-1231-login-fix');
const PROJECT = 'Keystone';

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
    [
      'schema_version = 1', '', '[project]', `display_name = "${PROJECT}"`, 'use_beads = true', '',
      '[git]', 'completed_work_branch = "main"', '', '[beads]', 'issue_id_prefix = "key"', '',
    ].join('\n'),
  );
  writeFileSync(join(REPO, '.gitignore'), ['worktrees/', ''].join('\n'));
  writeFileSync(join(REPO, 'alpha.txt'), 'start\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-m', 'start');
  git(REPO, 'worktree', 'add', WORKTREE, '-b', 'key-1231');
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as { id: string; path: string }[];
  const had = listed.find((p) => p.path === REPO);
  if (had) return had;
  const made = await request.post('/api/projects', { data: { name: PROJECT, path: REPO, isTest: true } });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

async function showTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/(projects|workbench\/notifications)(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

async function startChat(request: APIRequestContext, project: { id: string; path: string }): Promise<string> {
  const started = await request.post('/api/workbench/command', {
    data: {
      type: 'session.start',
      projectId: project.id,
      projectPath: project.path,
      cwd: WORKTREE,
      brand: 'claude',
      permissionMode: 'bypassPermissions',
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  return ((await started.json()) as { id: string }).id;
}

test.describe('a chat name template', () => {
  test.describe.configure({ timeout: 300_000, mode: 'serial' });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    seedRepository();
  });

  test.afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('names a chat by its ticket key and leaves a hand-typed name alone', async ({ page, request }) => {
    test.skip(
      !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'),
      'needs the scripted ACP agent; run with BEADS_E2E_ACP_ADAPTERS=$PWD/tests/fixtures/acp-adapters',
    );
    await showTestProjects(page);
    const project = await fixtureProject(request);
    try {
      const unnamed = await startChat(request, project);
      const renamed = await startChat(request, project);
      const rename = await request.post('/api/workbench/command', {
        data: { type: 'session.rename', sessionId: renamed, title: 'My own words' },
      });
      expect(rename.ok(), await rename.text()).toBe(true);

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${unnamed}`);
      const names = page.getByTestId('row-name');
      // Before: the folder, whole.
      await expect(names.filter({ hasText: 'key-1231-login-fix' })).toHaveCount(1, { timeout: WAY_IN_MS });

      await page.goto(`/project?id=${project.id}&settings=chat-names`);
      await page.getByTestId('chat-name-preset').click();
      await expect(page.getByTestId('chat-name-chip')).toHaveCount(3);
      const previewed = page.getByTestId('chat-name-preview-then');
      await expect(previewed.filter({ hasText: /^key-1231$/ })).toHaveCount(1, { timeout: 10_000 });
      await expect(previewed.filter({ hasText: 'My own words' })).toHaveCount(1);
      await page.screenshot({ path: `${SHOTS}/editor.png` });
      await page.getByTestId('project-settings-save').click();
      await expect(page.getByTestId('project-settings-save')).toBeDisabled({ timeout: 10_000 });

      // The rail, the tray's answer and the search all come from the same rule.
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${unnamed}`);
      await expect(names.filter({ hasText: /^key-1231$/ })).toHaveCount(1, { timeout: WAY_IN_MS });
      await expect(names.filter({ hasText: 'My own words' })).toHaveCount(1);
      await expect(names.filter({ hasText: 'key-1231-login-fix' })).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/rail.png` });

      const settings = (await (await request.get(`/api/projects/${project.id}/settings`)).json()) as {
        manifest: { chat_name?: { parts: { kind: string }[] } };
      };
      expect(settings.manifest.chat_name?.parts.map((part) => part.kind)).toEqual(['extract', 'text', 'title']);

      // A pattern that does not compile is refused, not written.
      const broken = await request.patch(`/api/projects/${project.id}/settings`, {
        data: { ...settings.manifest, chat_name: { parts: [{ kind: 'extract', source: 'worktree', pattern: 'key-(' }] }, instructions: '' },
      });
      expect(broken.ok()).toBe(false);
      expect(await broken.text()).toContain('Not a valid pattern');
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
