import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// One memory, edited from the Agent guidance tab and from `atelier tool
// memory` in a linked worktree, reaching every chat's instructions.
test.describe.configure({ mode: 'serial' });
const results = 'tests/results/atelier-memory';
const binary = resolve(process.env.ATELIER_BINARY ?? join(process.env.CARGO_TARGET_DIR ?? 'server/target', 'debug', 'atelier'));
let project: { id: string; path: string };
let worktree: string;
const memory = (cwd: string, ...args: string[]) => execFileSync(binary, ['tool', 'memory', ...args], { cwd, encoding: 'utf8' });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'core.hooksPath=/dev/null', ...args]);
const guidance = async (request: import('@playwright/test').APIRequestContext, path?: string) =>
  (await (await request.get(`/api/settings/library${path ? `?path=${encodeURIComponent(path)}` : ''}`)).json()).guidance as string;

test.beforeAll(async ({ request }) => {
  const run = process.env.WORKBENCH_E2E_RUN!;
  expect(run).toBeTruthy();
  expect(process.env.ATELIER_DATA_DIR).toContain(run);
  mkdirSync(join(run, 'projects'), { recursive: true });
  mkdirSync(results, { recursive: true });
  const path = mkdtempSync(join(run, 'projects', 'memory-'));
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'commit', '-q', '--allow-empty', '-m', 'start');
  worktree = join(path, 'worktrees', 'job');
  git(path, 'worktree', 'add', '-q', '-b', 'job', worktree);
  const response = await request.post('/api/projects', { data: { name: 'Memory Project', path } });
  expect(response.ok()).toBeTruthy(); project = await response.json();
  await request.get(`/api/projects/${project.id}/settings`);
});
test.afterAll(async ({ request }) => { if (project) await request.delete(`/api/projects/${project.id}`); });

test('a global memory saved in Settings reaches every chat and the CLI', async ({ page, request }) => {
  await page.goto('/settings?section=library');
  await page.getByRole('radio', { name: 'Memories', exact: true }).click();
  await expect(page.getByText('No global memories yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Add memory' }).click();
  await page.getByLabel('Memory ID').fill('plain-prose');
  await page.getByLabel('Memory description').fill('The user wants short plain sentences');
  await page.getByLabel('Memory body').fill('Write short, plain sentences.\nWhy: the user finds dense prose hard to read.');
  await page.getByRole('button', { name: 'Save memory' }).click();
  await expect(page.getByTestId('memory-global-plain-prose')).toContainText('The user wants short plain sentences');
  await expect(page.getByRole('status')).toContainText('New and reconnected chats receive this change.');
  // The Instructions list does not show memory as an editable instruction.
  await page.getByRole('radio', { name: 'Instructions', exact: true }).click();
  await expect(page.getByTestId('library-item-atelier-memory-global')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Memories', exact: true }).click();
  await page.getByTestId('memory-global-plain-prose').getByText('View memory').click();
  await page.screenshot({ path: join(results, 'global-memories.png'), animations: 'disabled' });

  expect(await guidance(request)).toContain('global instructions — Global memory:');
  expect(await guidance(request, project.path)).toContain('Write short, plain sentences.');
  expect(memory(worktree, 'show', 'plain-prose')).toContain('Why: the user finds dense prose hard to read.');
});

test('project memory added from a worktree is edited, guarded and deleted in project settings', async ({ page, request }) => {
  memory(worktree, 'add', 'owner-port', '--scope', 'project', '--type', 'reference', '--description', 'The owner app runs on 3008', '--body', 'Never touch port 3008.');
  expect(await guidance(request, project.path)).toContain('project instructions — Project memory:');
  expect(await guidance(request)).not.toContain('Never touch port 3008.');

  await page.goto(`/project?id=${project.id}&settings=instructions`);
  await page.getByRole('radio', { name: 'Memories', exact: true }).click();
  const card = page.getByTestId('memory-project-owner-port');
  await expect(card).toContainText('The owner app runs on 3008');
  await expect(card).toContainText('Reference');
  const inherited = page.getByTestId('memory-global-plain-prose');
  await expect(inherited).toBeVisible();
  await expect(inherited.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByTestId('library-item-atelier-memory-project')).toHaveCount(0);
  await page.screenshot({ path: join(results, 'project-memories.png'), animations: 'disabled', fullPage: true });

  await card.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Memory body').fill('Never touch port 3008 or its data.');
  await page.screenshot({ path: join(results, 'project-memory-editor.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Save memory' }).click();
  await expect(page.getByRole('status')).toContainText('Saved owner-port.');
  expect(memory(project.path, 'show', 'owner-port')).toContain('Never touch port 3008 or its data.');

  // An agent edits the memory while the page still holds the older copy.
  memory(worktree, 'edit', 'owner-port', '--body', 'Changed by an agent.');
  await page.getByTestId('memory-project-owner-port').getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Memory description').fill('A stale edit');
  await page.getByRole('button', { name: 'Save memory' }).click();
  await expect(page.getByRole('alert')).toContainText('changed in another editor');
  expect(memory(project.path, 'show', 'owner-port')).toContain('Changed by an agent.');
  await page.getByRole('button', { name: 'Discard draft and reload' }).click();

  await page.getByTestId('memory-project-owner-port').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete memory' }).click();
  await expect(page.getByTestId('memory-project-owner-port')).toHaveCount(0);
  expect(memory(worktree, 'list')).not.toContain('owner-port');
  expect(await guidance(request, project.path)).not.toContain('Project memory:');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(results, 'project-memories-mobile.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  memory(worktree, 'remove', 'plain-prose');
});
