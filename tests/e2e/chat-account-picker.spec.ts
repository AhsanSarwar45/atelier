import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const FIXTURE = join(__dirname, '..', '.workbench-run-account-picker');
const SHOT = join(__dirname, '..', 'results', 'chat-account-picker-after.png');

test('an existing chat changes account from its composer', async ({ page, request }) => {
  test.setTimeout(180_000);
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  mkdirSync(join(__dirname, '..', 'results'), { recursive: true });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await request.post('/api/projects', {
    data: { name: 'account-picker', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = await made.json() as { id: string; path: string };

  try {
    const profile = await request.post('/api/workbench/command', {
      data: { type: 'profile.create', brand: 'claude', name: 'Work account' },
    });
    expect(profile.ok(), await profile.text()).toBeTruthy();
    const started = await request.post('/api/workbench/command', {
      data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' },
    });
    expect(started.ok(), await started.text()).toBeTruthy();
    const chat = await started.json() as { id: string };

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${chat.id}`);
    const picker = page.getByTestId('account-picker');
    await expect(picker).toHaveAttribute('data-current', 'system', { timeout: 120_000 });
    await picker.click();
    const work = page.getByTestId('account-picker-option').filter({ hasText: 'Work account' });
    await expect(work).toBeVisible();
    await work.click();

    await expect(picker).not.toHaveAttribute('data-current', 'system', { timeout: 30_000 });
    await expect(page.getByText('Account changed to Work account.')).toBeVisible();
    await picker.click();
    await page.getByTestId('composer-frame').screenshot({ path: SHOT });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
