import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Orchestrator chats and the worker chats they start, as the owner sees them
 * (docs/designs/orchestrator-workers.md, How it looks).
 *
 * The owner turns on Workers when starting a chat and picks the provider the
 * workers run on. Worker chats then sit under their orchestrator in the list,
 * the orchestrator's details list them, and each worker links back.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/worker-chats.spec.ts
 */

const FIXTURE = join(__dirname, '..', '.workbench-run-worker-chats');
const SHOTS = 'tests/results/worker-chats';

test.describe.configure({ timeout: 120_000 });

async function project(request: APIRequestContext, name: string): Promise<{ id: string; path: string }> {
  const path = join(FIXTURE, name);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return { ...((await made.json()) as { id: string }), path };
}

async function command(request: APIRequestContext, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await request.post('/api/workbench/command', { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

test.beforeEach(async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
});

test('the new chat dialog starts a chat with workers on the chosen provider', async ({ page, request }) => {
  const made = await project(request, 'workers-dialog');
  const started: string[] = [];
  try {
    await page.goto(`/project?id=${made.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    const dialog = page.getByRole('dialog', { name: 'New chat' });
    await expect(dialog).toBeVisible();
    await dialog.screenshot({ path: `${SHOTS}/dialog-before.png` });

    const use = dialog.getByRole('switch', { name: 'Use workers' });
    await expect(use).not.toBeChecked();
    await use.click();
    const workers = dialog.getByRole('group', { name: 'Workers' });
    await workers.getByRole('radio', { name: 'Codex', exact: true }).click();
    await dialog.screenshot({ path: `${SHOTS}/dialog-after.png` });

    const start = page.waitForRequest((sent) => {
      if (!sent.url().endsWith('/api/workbench/command') || sent.method() !== 'POST') return false;
      return (sent.postDataJSON() as { type?: string }).type === 'session.start';
    });
    await dialog.getByRole('button', { name: 'Start chat' }).click();
    const body = (await start).postDataJSON() as { workers?: { brand?: string; profileId?: string } };
    expect(body.workers?.brand, JSON.stringify(body)).toBe('codex');
    expect(body.workers?.profileId, JSON.stringify(body)).toBeTruthy();
    const answer = await (await start).response();
    const id = ((await answer?.json()) as { id?: string } | undefined)?.id;
    if (id) started.push(id);

    // Remembered like the dialog's other choices.
    await page.getByTestId('new-chat-tool').click();
    await expect(page.getByRole('dialog', { name: 'New chat' }).getByRole('switch', { name: 'Use workers' })).toBeChecked();
  } finally {
    for (const sessionId of started) await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId } });
    await request.delete(`/api/projects/${made.id}`);
    rmSync(made.path, { recursive: true, force: true });
  }
});

test('workers sit under their orchestrator and link back to it', async ({ page, request }) => {
  const made = await project(request, 'workers-nesting');
  const started: string[] = [];
  try {
    const orchestrator = await command(request, {
      type: 'session.start', brand: 'claude', projectId: made.id, projectPath: made.path,
      title: 'Plan the login work', workers: { brand: 'codex', profileId: 'system' },
    });
    started.push(orchestrator.id as string);
    // With no workers yet the chat looks as it did before workers existed.
    await page.goto(`/project?id=${made.id}&tab=chat&chat=${orchestrator.id}`);
    await expect(page.getByTestId('chat-sidebar').getByText('Plan the login work')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/chat-before.png` });
    const worker = await command(request, {
      type: 'session.start', brand: 'codex', projectId: made.id, projectPath: made.path,
      title: 'Login form', parentSessionId: orchestrator.id,
    });
    started.push(worker.id as string);

    await page.goto(`/project?id=${made.id}&tab=chat&chat=${orchestrator.id}`);
    const list = page.getByTestId('chat-sidebar');
    await expect(list.getByText('Login form')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/sidebar-after.png` });

    // Folded away under the orchestrator, and back.
    await list.getByRole('button', { name: 'Hide workers' }).click();
    await expect(list.getByText('Login form')).toHaveCount(0);
    await list.getByRole('button', { name: 'Show workers' }).click();
    await expect(list.getByText('Login form')).toBeVisible();

    // The orchestrator's details list its workers.
    // Open unless it already is: a wide screen starts with the details open.
    const show = page.getByRole('button', { name: 'Show chat details' });
    if (await show.isVisible()) await show.click();
    const section = page.getByRole('region', { name: 'Workers' });
    await expect(section.getByText('Login form')).toBeVisible();
    await expect(section.getByRole('button', { name: 'Stop workers' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/rail-after.png` });

    // The worker links back to the chat that started it.
    await section.getByRole('link', { name: /Login form/ }).click();
    await expect(page).toHaveURL(new RegExp(`chat=${worker.id}`));
    await page.getByRole('link', { name: 'Worker of Plan the login work' }).click();
    await expect(page).toHaveURL(new RegExp(`chat=${orchestrator.id}`));
  } finally {
    for (const sessionId of started) await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId } });
    await request.delete(`/api/projects/${made.id}`);
    rmSync(made.path, { recursive: true, force: true });
  }
});

test('the workers choice fits a phone screen', async ({ page, request }) => {
  const made = await project(request, 'workers-phone');
  try {
    // Opened where the button shows, then narrowed to a phone with it open.
    await page.goto(`/project?id=${made.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = page.getByRole('dialog', { name: 'New chat' });
    await dialog.getByRole('switch', { name: 'Use workers' }).click();
    const workers = dialog.getByRole('group', { name: 'Workers' });
    await expect(workers).toBeVisible();
    await dialog.screenshot({ path: `${SHOTS}/dialog-phone-after.png` });
    const box = await workers.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390, `the Workers choice runs off the screen: ${JSON.stringify(box)}`).toBe(true);
    const spills = await dialog.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(spills, 'the dialog scrolls sideways').toBe(false);
  } finally {
    await request.delete(`/api/projects/${made.id}`);
    rmSync(made.path, { recursive: true, force: true });
  }
});
