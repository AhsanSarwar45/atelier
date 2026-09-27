import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { PARENT_CARD, discardFixture, makeFixtureProject } from './fixture-board';
import { writeChatWithHelper } from './fixture-record';

/**
 * The RAM popup is a tree (bw-7as6r.1).
 *
 * It used to be three flat lists — chats, every process, every container —
 * so finding what one chat held meant reading its title off dozens of rows.
 * Each chat is now one entry that opens to its own process tree and its
 * containers, the app's own processes sit under one App entry split by what
 * they do, and containers nobody here started are listed apart.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-ram-popup-nests-by-owner.spec.ts
 */

const runDir = (): string => join(__dirname, '..', `.workbench-run-ram-tree-${randomUUID()}`);
const SHOTS = join(process.cwd(), 'tests', 'results', 'the-ram-popup-nests-by-owner');
const OPEN_MS = 60_000;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

const row = (pid: number, parentPid: number, name: string, bytes: number, role: string, chat?: [string, string]) => ({
  pid, parentPid, name, bytes, swapBytes: 0, sessionId: chat?.[0] ?? null, chatTitle: chat?.[1] ?? null,
  role, killable: role === 'subprocess', startTime: pid,
});
const ESSAYS: [string, string] = ['chat-1', 'Grade the essays'];
const DOCS: [string, string] = ['chat-2', 'Write the docs'];

const REPORT = {
  totalBytes: 3.2 * GB,
  swapBytes: 0,
  metric: 'pssWithSwap',
  processCount: 11,
  chats: [
    { sessionId: 'chat-1', title: 'Grade the essays', bytes: 1.6 * GB, processes: 5, containerBytes: 5 * GB, containers: 2 },
    { sessionId: 'chat-2', title: 'Write the docs', bytes: 400 * MB, processes: 2, containerBytes: 0, containers: 0 },
  ],
  processDetails: [
    row(10, 1, 'atelier', 500 * MB, 'app'),
    row(11, 10, 'claude', 160 * MB, 'accountReader'),
    row(12, 10, 'codex', 130 * MB, 'accountReader'),
    row(13, 10, 'node', 90 * MB, 'appService'),
    row(20, 10, 'claude-acp', 100 * MB, 'chatAdapter', ESSAYS),
    row(21, 20, 'claude', 600 * MB, 'provider', ESSAYS),
    row(22, 21, 'bash', 20 * MB, 'subprocess', ESSAYS),
    row(23, 22, 'cargo', 480 * MB, 'subprocess', ESSAYS),
    row(24, 22, 'node', 400 * MB, 'subprocess', ESSAYS),
    row(30, 10, 'codex-acp', 100 * MB, 'chatAdapter', DOCS),
    row(31, 30, 'codex', 300 * MB, 'provider', DOCS),
  ],
  containers: [
    { id: '058a477a41da', name: 'keystone-web', image: 'keystone-web', bytes: 4.6 * GB, cacheBytes: 0, sessionId: 'chat-1', chatTitle: 'Grade the essays', owner: 'label', project: 'keystone', workingDir: '/work/keystone' },
    { id: '9064b24666ca', name: 'keystone-postgres', image: 'pgvector/pgvector:pg16', bytes: 0.4 * GB, cacheBytes: 0, sessionId: 'chat-1', chatTitle: 'Grade the essays', owner: 'workingDir', project: 'keystone', workingDir: '/work/keystone' },
    { id: '1fbf48b89dd1', name: 'searxng', image: 'searxng/searxng:latest', bytes: 0.2 * GB, cacheBytes: 0, sessionId: null, chatTitle: null, owner: null, project: null, workingDir: null },
  ],
};

test.setTimeout(120_000);

async function projectAt(request: APIRequestContext, name: string, path: string): Promise<{ id: string }> {
  const made = await request.post('/api/projects', { data: { name, path } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

async function aChatOnScreen(page: Page, request: APIRequestContext): Promise<string> {
  const run = runDir();
  const path = join(run, 'project');
  mkdirSync(run, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  makeFixtureProject(path, join(run, 'reports'));
  const project = await projectAt(request, `workbench-ram-tree-${randomUUID().slice(0, 8)}`, path);
  const written = writeChatWithHelper({ cwd: path, sessionId: randomUUID(), card: PARENT_CARD });
  await page.goto(`/project?id=${project.id}&tab=chat`);
  const row = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
  await row.waitFor({ timeout: OPEN_MS });
  await row.getByTestId('row-name').click();
  await page.getByTestId('chat-status-line').waitFor({ timeout: OPEN_MS });
  return run;
}

test('each chat and the app are one entry that opens to what they hold', async ({ page, request }) => {
  await page.route('**/api/workbench/memory', route => route.fulfill({ json: REPORT }));
  const run = await aChatOnScreen(page, request);
  try {
    const badge = page.getByTestId('memory-badge');
    await expect(badge).toHaveText('8.2 GB', { timeout: OPEN_MS });
    await badge.click();
    const popup = page.getByTestId('memory-popup');
    await expect(popup).toBeVisible();
    // The popover fades in; a picture taken mid-fade shows the chat through it.
    await expect(popup).toHaveCSS('opacity', '1');
    await page.screenshot({ path: join(SHOTS, 'closed.png'), clip: { x: 288, y: 96, width: 560, height: 720 } });

    // Top level: the chats by size, then App, then the containers nobody here started.
    const groups = popup.getByTestId('memory-group');
    await expect(groups).toHaveCount(4);
    await expect(groups.nth(0)).toContainText('Grade the essays');
    await expect(groups.nth(0)).toContainText('6.6 GB');
    await expect(groups.nth(1)).toContainText('Write the docs');
    await expect(groups.nth(2)).toContainText('App');
    await expect(groups.nth(2)).toContainText('880 MB');
    await expect(groups.nth(3)).toContainText('Other containers');
    await expect(groups.nth(3)).toContainText('Not counted');
    // Closed entries hold no rows.
    await expect(popup.getByTestId('memory-process-row')).toHaveCount(0);

    // A chat opens to its process tree and its containers.
    await groups.nth(0).getByRole('button', { name: /Grade the essays/ }).click();
    const essays = groups.nth(0);
    await expect(essays.getByTestId('memory-process-row')).toHaveCount(5);
    await expect(essays.getByTestId('memory-container-row')).toHaveCount(2);
    await expect(essays.getByTestId('memory-container-row').nth(1)).toContainText('Matched by folder');
    const cargo = essays.getByTestId('memory-process-row').filter({ hasText: 'cargo' });
    const adapter = essays.getByTestId('memory-process-row').filter({ hasText: 'claude-acp' });
    await expect(cargo).toHaveAttribute('data-depth', '3');
    await expect(adapter).toHaveAttribute('data-depth', '0');
    await expect(cargo.getByRole('button', { name: 'Stop cargo' })).toBeVisible();

    // App opens to its groups.
    await groups.nth(2).getByRole('button', { name: /App/ }).click();
    const app = groups.nth(2);
    await expect(app.getByTestId('memory-subgroup')).toHaveCount(3);
    await expect(app.getByTestId('memory-subgroup').nth(1)).toContainText('Usage readers');
    await expect(app.getByTestId('memory-subgroup').nth(1)).toContainText('290 MB');
    await page.screenshot({ path: join(SHOTS, 'open.png'), clip: { x: 288, y: 96, width: 560, height: 720 } });
  } finally {
    discardFixture(run);
  }
});
