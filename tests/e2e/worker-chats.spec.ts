import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Orchestrator chats and the worker chats they start, as the owner sees them
 * (docs/designs/orchestrator-workers.md, How it looks).
 *
 * The owner picks Workers in the chat bar, like the chat's other settings:
 * None, or the provider and account the workers run on. The orchestrator's details list its workers, like subagents,
 * rather than the chat list, and each worker links back.
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

test('the chat bar Workers setting chooses none or a provider and account', async ({ page, request }) => {
  const made = await project(request, 'workers-bar');
  const started: string[] = [];
  try {
    const chat = await command(request, {
      type: 'session.start', brand: 'claude', projectId: made.id, projectPath: made.path, title: 'Plan the login work',
    });
    started.push(chat.id as string);
    await page.goto(`/project?id=${made.id}&tab=chat&chat=${chat.id}`);
    const workers = page.getByTestId('workers-picker');
    await expect(workers).toHaveAttribute('data-current', 'none');
    await expect(workers).toHaveAccessibleName(/Workers/);
    await page.getByTestId('desktop-composer-settings').screenshot({ path: `${SHOTS}/bar-off-after.png` });

    await workers.click();
    const menu = page.getByTestId('workers-picker-menu');
    await expect(menu.getByText('None', { exact: true })).toBeVisible();
    await expect(menu.locator('[data-testid="workers-picker-option"][data-value^="codex:"]').first()).toBeVisible();
    // Taken once the menu has finished opening, not mid-fade.
    await menu.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((one) => one.finished)));
    await page.screenshot({ path: `${SHOTS}/bar-menu-after.png` });
    await menu.locator('[data-testid="workers-picker-option"][data-value^="codex:"]').first().click();
    await expect(workers).toHaveAttribute('data-current', /^codex:/);
    await page.getByTestId('desktop-composer-settings').screenshot({ path: `${SHOTS}/bar-after.png` });

    // Kept on the chat, so it is still there after a reload.
    await page.reload();
    await expect(page.getByTestId('workers-picker')).toHaveAttribute('data-current', /^codex:/);

    // And None turns workers off again.
    await page.getByTestId('workers-picker').click();
    await page.locator('[data-testid="workers-picker-option"][data-value="none"]').click();
    await expect(page.getByTestId('workers-picker')).toHaveAttribute('data-current', 'none');
  } finally {
    for (const sessionId of started) await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId } });
    await request.delete(`/api/projects/${made.id}`);
    rmSync(made.path, { recursive: true, force: true });
  }
});

test('the worker model and effort are chosen in the chat bar before any worker starts', async ({ page, request }) => {
  const made = await project(request, 'workers-model');
  const started: string[] = [];
  try {
    // A Codex chat in the project, so Atelier knows what Codex offers.
    const codex = await command(request, {
      type: 'session.start', brand: 'codex', projectId: made.id, projectPath: made.path, title: 'A Codex chat',
    });
    started.push(codex.id as string);
    await page.goto(`/project?id=${made.id}&tab=chat&chat=${codex.id}`);
    await expect(page.getByTestId('model-picker')).toBeVisible({ timeout: 60_000 });

    const chat = await command(request, {
      type: 'session.start', brand: 'claude', projectId: made.id, projectPath: made.path, title: 'Plan the login work',
    });
    started.push(chat.id as string);
    await page.goto(`/project?id=${made.id}&tab=chat&chat=${chat.id}`);
    // With no workers there is no worker model to choose.
    await expect(page.getByTestId('workers-model-picker'), 'a worker model is offered with workers off').toHaveCount(0);
    await page.getByTestId('workers-picker').click();
    await page.locator('[data-testid="workers-picker-option"][data-value^="codex:"]').first().click();

    const model = page.getByTestId('workers-model-picker');
    await expect(model).toHaveAttribute('data-current', 'default');
    await model.click();
    const offered = page.locator('[data-testid="workers-model-picker-option"]:not([data-value="default"])');
    await expect(offered.first(), 'no Codex model is offered for workers').toBeVisible();
    const picked = await offered.first().getAttribute('data-value');
    await offered.first().click();
    await expect(model).toHaveAttribute('data-current', picked!);
    await expect(page.getByTestId('workers-effort-picker')).toBeVisible();
    await page.getByTestId('desktop-composer-settings').screenshot({ path: `${SHOTS}/worker-model-after.png` });

    // Kept on the chat with the provider and account.
    await page.reload();
    await expect(page.getByTestId('workers-model-picker')).toHaveAttribute('data-current', picked!);
  } finally {
    for (const sessionId of started) await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId } });
    await request.delete(`/api/projects/${made.id}`);
    rmSync(made.path, { recursive: true, force: true });
  }
});

test('the Workers setting works from the keyboard', async ({ page, request }) => {
  const made = await project(request, 'workers-keyboard');
  const started: string[] = [];
  try {
    const chat = await command(request, {
      type: 'session.start', brand: 'claude', projectId: made.id, projectPath: made.path, title: 'Keyboard chat',
    });
    started.push(chat.id as string);
    await page.goto(`/project?id=${made.id}&tab=chat&chat=${chat.id}`);
    const workers = page.getByTestId('workers-picker');
    await expect(workers).toHaveAttribute('data-current', 'none');
    await workers.focus();
    await page.keyboard.press('Enter');
    const codex = page.locator('[data-testid="workers-picker-option"][data-value^="codex:"]').first();
    await expect(codex).toBeVisible();
    await codex.focus();
    await page.keyboard.press('Enter');
    await expect(workers).toHaveAttribute('data-current', /^codex:/);
  } finally {
    for (const sessionId of started) await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId } });
    await request.delete(`/api/projects/${made.id}`);
    rmSync(made.path, { recursive: true, force: true });
  }
});

test('the new chat dialog no longer asks about workers', async ({ page, request }) => {
  const made = await project(request, 'workers-dialog');
  try {
    await page.goto(`/project?id=${made.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    const dialog = page.getByRole('dialog', { name: 'New chat' });
    await expect(dialog.getByRole('button', { name: 'Start chat' })).toBeVisible();
    await expect(dialog.getByRole('switch', { name: 'Use workers' }), 'the dialog still asks about workers').toHaveCount(0);
    await dialog.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((one) => one.finished)));
    await dialog.screenshot({ path: `${SHOTS}/new-chat-after.png` });
  } finally {
    await request.delete(`/api/projects/${made.id}`);
    rmSync(made.path, { recursive: true, force: true });
  }
});

test('workers show in their orchestrator details, not the chat list, and link back to it', async ({ page, request }) => {
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
    // Like a subagent, a worker is not a row of the chat list.
    const list = page.getByTestId('chat-sidebar');
    await expect(list.getByText('Plan the login work')).toBeVisible();
    await expect(list.getByText('Login form')).toHaveCount(0);

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

test('the Workers setting fits a phone screen', async ({ page, request }) => {
  const made = await project(request, 'workers-phone');
  const started: string[] = [];
  try {
    const chat = await command(request, {
      type: 'session.start', brand: 'claude', projectId: made.id, projectPath: made.path, title: 'Phone chat',
    });
    started.push(chat.id as string);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/project?id=${made.id}&tab=chat&chat=${chat.id}`);
    await page.getByTestId('mobile-composer-settings').click();
    const settings = page.getByTestId('mobile-composer-settings-dialog');
    const workers = settings.getByTestId('mobile-workers-picker');
    await expect(workers).toBeVisible();
    await settings.screenshot({ path: `${SHOTS}/phone-after.png` });
    const box = await workers.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390, `the Workers setting runs off the screen: ${JSON.stringify(box)}`).toBe(true);
    const spills = await settings.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(spills, 'the chat settings scroll sideways').toBe(false);
  } finally {
    for (const sessionId of started) await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId } });
    await request.delete(`/api/projects/${made.id}`);
    rmSync(made.path, { recursive: true, force: true });
  }
});

test('the worker model setting fits a phone screen and works from the keyboard', async ({ page, request }) => {
  const made = await project(request, 'workers-model-phone');
  const started: string[] = [];
  try {
    const codex = await command(request, {
      type: 'session.start', brand: 'codex', projectId: made.id, projectPath: made.path, title: 'A Codex chat',
    });
    started.push(codex.id as string);
    await page.goto(`/project?id=${made.id}&tab=chat&chat=${codex.id}`);
    await expect(page.getByTestId('model-picker')).toBeVisible({ timeout: 60_000 });
    const chat = await command(request, {
      type: 'session.start', brand: 'claude', projectId: made.id, projectPath: made.path, title: 'Phone chat',
    });
    started.push(chat.id as string);
    await command(request, { type: 'session.workers', sessionId: chat.id, workers: { brand: 'codex', profileId: 'system' } });

    // Keyboard: open the worker model menu and choose a model with Enter.
    await page.goto(`/project?id=${made.id}&tab=chat&chat=${chat.id}`);
    const model = page.getByTestId('workers-model-picker');
    await model.focus();
    await page.keyboard.press('Enter');
    const offered = page.locator('[data-testid="workers-model-picker-option"]:not([data-value="default"])').first();
    await expect(offered).toBeVisible();
    const picked = await offered.getAttribute('data-value');
    await offered.focus();
    await page.keyboard.press('Enter');
    await expect(model).toHaveAttribute('data-current', picked!);

    // Phone: the worker model and effort sit inside the screen.
    // Opened afresh at phone width, as a phone opens it: the desktop's open
    // side panel would otherwise become a sheet over the chat.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/project?id=${made.id}&tab=chat&chat=${chat.id}`);
    await page.getByTestId('mobile-composer-settings').click();
    const settings = page.getByTestId('mobile-composer-settings-dialog');
    for (const testid of ['mobile-workers-model-picker', 'mobile-workers-effort-picker']) {
      const box = await settings.getByTestId(testid).boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 390, `${testid} runs off the screen: ${JSON.stringify(box)}`).toBe(true);
    }
    expect(await settings.evaluate((el) => el.scrollWidth > el.clientWidth), 'the chat settings scroll sideways').toBe(false);
    await settings.screenshot({ path: `${SHOTS}/worker-model-phone-after.png` });
  } finally {
    for (const sessionId of started) await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId } });
    await request.delete(`/api/projects/${made.id}`);
    rmSync(made.path, { recursive: true, force: true });
  }
});
