import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * A Claude chat moved to Codex from its right-click menu keeps its past: the
 * earlier messages stay on the page, through a reload, and Codex answers from
 * what was said to Claude.
 *
 * Needs both real providers: run with BEADS_E2E_LIVE_PROVIDERS=1.
 */
const FIXTURE = join(__dirname, '..', '.workbench-run-switch-provider');
const RESULTS = join(__dirname, '..', 'results');
const WORD = 'ZEBRA-731';

async function say(page: Page, text: string) {
  const writing = page.getByTestId('composer-frame').locator('.cm-content');
  await writing.click();
  await page.keyboard.type(text);
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 180_000 });
}

const times = async (page: Page) =>
  ((await page.getByTestId('transcript').innerText()).match(new RegExp(WORD, 'g')) ?? []).length;

test('a Claude chat switches to Codex and carries on', async ({ page, request }) => {
  test.skip(process.env.BEADS_E2E_LIVE_PROVIDERS !== '1', 'needs real Claude and Codex logins');
  test.setTimeout(600_000);
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  mkdirSync(RESULTS, { recursive: true });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await request.post('/api/projects', {
    data: { name: 'switch-provider', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = await made.json() as { id: string; path: string };

  try {
    const started = await request.post('/api/workbench/command', {
      data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' },
    });
    expect(started.ok(), await started.text()).toBeTruthy();
    const chat = await started.json() as { id: string };

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${chat.id}`);
    await expect(page.getByTestId('composer-frame')).toBeVisible({ timeout: 120_000 });
    await say(page, `Remember the code word ${WORD}. Reply with only: OK`);

    const row = page.locator(`[data-testid="restore-row"][data-row-key="${chat.id}"]`);
    await expect(row).toHaveAttribute('data-brand', 'claude');
    await row.click({ button: 'right' });
    await page.getByTestId('chat-menu-switch-provider').click();
    const dialog = page.getByTestId('switch-provider-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('new-chat-provider-claude')).toBeDisabled();
    await expect(dialog.getByTestId('new-chat-provider-codex')).toHaveAttribute('data-state', 'on');
    await dialog.screenshot({ path: join(RESULTS, 'switch-provider-dialog.png') });
    await dialog.getByTestId('switch-provider-confirm').click();
    await expect(dialog).toBeHidden();

    await expect(row).toHaveAttribute('data-brand', 'codex', { timeout: 30_000 });
    expect(await times(page)).toBe(1);

    await say(page, 'What code word did I ask you to remember? Reply with only the code word.');
    await expect.poll(() => times(page), { timeout: 60_000 }).toBe(2);
    await page.screenshot({ path: join(RESULTS, 'switch-provider-after.png') });

    // The past is Atelier's now: reading the Codex record back in on a reload
    // must not replace the part said to Claude.
    await page.reload();
    await expect(page.getByTestId('transcript')).toContainText(`Remember the code word ${WORD}`, { timeout: 60_000 });
    await expect.poll(() => times(page), { timeout: 30_000 }).toBe(2);
    // The Claude conversation it left is this chat's past, not a second chat.
    await expect(page.getByTestId('restore-row')).toHaveCount(1);
    await page.reload();
    await expect(row).toHaveAttribute('data-brand', 'codex', { timeout: 60_000 });
    await expect(page.getByTestId('restore-row')).toHaveCount(1);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
