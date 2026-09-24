import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { PARENT_CARD, discardFixture, makeFixtureProject } from './fixture-board';
import { writeChatWithHelper } from './fixture-record';

/**
 * The RAM badge counts the Docker containers a chat started (bw-meh1.2).
 *
 * A container is started by the Docker daemon, not by the command that asked
 * for it, so it was never one of the chat's processes and the badge left it
 * out: a chat that brought up a stack of several gigabytes read as a few
 * hundred megabytes. Each chat now reaches Docker through a socket of its own
 * that labels what it creates, and the report charges each running container
 * to the chat its label names, or to the running chat whose folder Compose
 * started it from.
 *
 * Two questions:
 *
 *  * against the real server, on a machine with containers running, the
 *    popover lists them — route, Docker reader and badge agree end to end. No
 *    chat here started them, so none is charged for them;
 *  * against a report where a chat owns containers, the chip and the chat's
 *    row count them, and a container nobody here started is listed but not
 *    charged to Atelier.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-ram-badge-counts-chat-containers.spec.ts
 */

const runDir = (): string => join(__dirname, '..', `.workbench-run-ram-containers-${randomUUID()}`);
const SHOTS = join(process.cwd(), 'tests', 'results', 'the-ram-badge-counts-chat-containers');
const OPEN_MS = 60_000;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** A chat holding 1 GB in processes and 5 GB in two containers it started. */
const WITH_CONTAINERS = {
  totalBytes: 1.5 * GB,
  swapBytes: 0,
  metric: 'pssWithSwap',
  processCount: 3,
  chats: [{ sessionId: 'chat-1', title: 'Grade the essays', bytes: 1 * GB, processes: 2, containerBytes: 5 * GB, containers: 2 }],
  processDetails: [
    { pid: 10, parentPid: null, name: 'atelier', bytes: 500 * MB, swapBytes: 0, sessionId: null, chatTitle: null, role: 'app', killable: false, startTime: 1 },
    { pid: 12, parentPid: 11, name: 'claude', bytes: 600 * MB, swapBytes: 0, sessionId: 'chat-1', chatTitle: 'Grade the essays', role: 'provider', killable: false, startTime: 2 },
    { pid: 13, parentPid: 12, name: 'node', bytes: 424 * MB, swapBytes: 0, sessionId: 'chat-1', chatTitle: 'Grade the essays', role: 'subprocess', killable: true, startTime: 3 },
  ],
  containerBytes: 5.2 * GB,
  containers: [
    { id: '058a477a41da', name: 'keystone-web-300', image: 'keystone300-web', bytes: 4.6 * GB, cacheBytes: 800 * MB, sessionId: 'chat-1', chatTitle: 'Grade the essays', owner: 'label', project: 'keystone300', workingDir: '/work/keystone' },
    { id: '9064b24666ca', name: 'keystone-postgres-300', image: 'pgvector/pgvector:pg16', bytes: 0.4 * GB, cacheBytes: 30 * MB, sessionId: 'chat-1', chatTitle: 'Grade the essays', owner: 'workingDir', project: 'keystone300', workingDir: '/work/keystone' },
    { id: '1fbf48b89dd1', name: 'searxng', image: 'searxng/searxng:latest', bytes: 0.2 * GB, cacheBytes: 0, sessionId: null, chatTitle: null, owner: null, project: null, workingDir: null },
  ],
};

test.setTimeout(120_000);

async function projectAt(request: APIRequestContext, name: string, path: string): Promise<{ id: string }> {
  const made = await request.post('/api/projects', { data: { name, path } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

/** A project with one written chat, opened, with the status line on screen. */
async function aChatOnScreen(page: Page, request: APIRequestContext): Promise<string> {
  const run = runDir();
  const path = join(run, 'project');
  mkdirSync(run, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  makeFixtureProject(path, join(run, 'reports'));
  const project = await projectAt(request, `workbench-ram-containers-${randomUUID().slice(0, 8)}`, path);
  const written = writeChatWithHelper({ cwd: path, sessionId: randomUUID(), card: PARENT_CARD });

  await page.goto(`/project?id=${project.id}&tab=chat`);
  const row = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
  await row.waitFor({ timeout: OPEN_MS });
  await row.getByTestId('row-name').click();
  await page.getByTestId('chat-status-line').waitFor({ timeout: OPEN_MS });
  return run;
}

test('the real server lists the running containers and charges none of them to a chat that did not start them', async ({ page, request }) => {
  const report = await (await request.get('/api/workbench/memory')).json() as { containers?: unknown[] };
  test.skip(!report.containers?.length, 'no Docker container is running on this machine');
  const run = await aChatOnScreen(page, request);
  try {
    await page.getByTestId('memory-badge').click();
    const rows = page.getByTestId('memory-container-row');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toContainText(/\d+(\.\d+)?\s(KB|MB|GB)/);
    await expect(rows.first()).toContainText('No chat');
    await expect(page.getByTestId('memory-container-line')).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'live.png') });
  } finally {
    discardFixture(run);
  }
});

test('a chat is charged for the containers it started, and a stranger container is not', async ({ page, request }) => {
  await page.route('**/api/workbench/memory', route => route.fulfill({ json: WITH_CONTAINERS }));
  const run = await aChatOnScreen(page, request);
  try {
    const badge = page.getByTestId('memory-badge');
    // 1.5 GB of processes and the chat's 5 GB of containers; searxng's 0.2 GB is not Atelier's.
    await expect(badge).toHaveText('6.5 GB', { timeout: OPEN_MS });
    await badge.click();
    const chat = page.getByTestId('memory-chat-row');
    await expect(chat).toContainText('6.0 GB');
    await expect(chat.getByTestId('memory-chat-containers')).toHaveText('1.0 GB in processes · 5.0 GB in 2 containers');
    const rows = page.getByTestId('memory-container-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Grade the essays');
    await expect(rows.nth(1)).toContainText('Grade the essays · matched by folder');
    await expect(rows.nth(2)).toContainText('No chat');
    const line = page.getByTestId('memory-container-line');
    await expect(line).toContainText('Processes 1.5 GB');
    await expect(line).toContainText('Chat containers 5.0 GB');
    await page.screenshot({ path: join(SHOTS, 'with-containers.png') });
  } finally {
    discardFixture(run);
  }
});
