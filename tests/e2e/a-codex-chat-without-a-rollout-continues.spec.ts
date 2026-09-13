import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * A readable Codex thread can lose the rollout file app-server needs in order
 * to resume it. Sending from that transcript must create a writable
 * continuation instead of printing app-server's internal error.
 *
 * Run: BEADS_E2E_ACP_MISSING_ROLLOUT=1 \
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" \
 *   CODEX_PATH="$PWD/tests/fixtures/acp-adapters/codex" \
 *   scripts/workbench-e2e.sh tests/e2e/a-codex-chat-without-a-rollout-continues.spec.ts
 */
const FIXTURE = join(__dirname, '..', '.workbench-run-missing-rollout');
const THREAD = 'acp-session-missing-rollout';

test('a Codex chat whose rollout is gone continues in a new provider thread', async ({ page, request }) => {
  test.setTimeout(120_000);
  test.skip(
    process.env.BEADS_E2E_ACP_MISSING_ROLLOUT !== '1',
    'needs the missing-rollout ACP fixture; see the header',
  );
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'Missing Codex rollout', path: FIXTURE, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByRole('button', { name: 'Show the agents\' own chats' }).click();

    const row = page.locator(
      `[data-testid="restore-row"][data-brand="codex"][data-external-id="${THREAD}"]`,
    );
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('composer')).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId('assistant-message')).toContainText('Its transcript is still readable.');

    const sessionId = await row.getAttribute('data-row-key');
    expect(sessionId).toBeTruthy();
    const sent = await request.post('/api/workbench/command', {
      data: { type: 'prompt.send', sessionId, text: 'Please keep going.' },
    });
    expect(sent.ok(), await sent.text()).toBe(true);

    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'The replacement Codex thread answered.' }).last(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByText('Can this saved chat continue?', { exact: true }),
    ).toHaveCount(1);
    await expect(page.getByText(/no rollout found for thread id/i)).toHaveCount(0);

    const rediscovered = page.waitForResponse((response) => (
      response.url().includes('/api/workbench/restore?')
      && !response.url().includes('local=1')
      && response.ok()
    ));
    await page.reload();
    await rediscovered;
    const showAgents = page.getByRole('button', { name: 'Show the agents\' own chats' });
    if (await showAgents.isVisible()) await showAgents.click();
    await expect(page.locator(`[data-testid="restore-row"][data-row-key="${sessionId}"]`)).toHaveCount(1);
    await expect(page.locator(
      `[data-testid="restore-row"][data-brand="codex"][data-external-id="${THREAD}"]`,
    )).toHaveCount(0);
    await page.locator(`[data-testid="restore-row"][data-row-key="${sessionId}"]`).getByTestId('row-name').click();
    await expect(page.getByText('The replacement Codex thread answered.', { exact: true })).toBeVisible();

    if (process.env.WORKBENCH_E2E_SHOT) {
      await page.getByTestId('transcript-rows').screenshot({ path: process.env.WORKBENCH_E2E_SHOT });
    }
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
