import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * The agent and model the AI search runs on are chosen in Settings and are
 * still chosen after a reload, because the server holds them (bw-21a2.4).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/search-settings-survive-a-reload.spec.ts
 */

const results = 'tests/results/search-settings';

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('the chosen provider and model survive a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings?section=search');
  await expect(page.getByTestId('search-settings')).toBeVisible();
  await page.screenshot({ path: join(results, 'before.png') });

  await page.getByTestId('search-provider').click();
  await page.getByRole('option', { name: 'Codex' }).click();
  await expect(page.getByTestId('search-provider')).toContainText('Codex');
  await page.getByTestId('search-model').click();
  const model = page.getByRole('option').nth(1);
  const named = (await model.textContent())!.trim();
  await model.click();
  await expect(page.getByTestId('search-model')).toContainText(named);
  await page.getByTestId('search-time-limit').click();
  await page.getByRole('option', { name: '5 minutes' }).click();
  await expect(page.getByTestId('search-time-limit')).toContainText('5 minutes');

  await page.reload();
  await expect(page.getByTestId('search-provider')).toContainText('Codex');
  await expect(page.getByTestId('search-model')).toContainText(named);
  await expect(page.getByTestId('search-time-limit')).toContainText('5 minutes');
  await expect(page.getByTestId('search-effort')).toBeVisible();
  await page.screenshot({ path: join(results, 'after.png') });

  // The server refuses a limit no search could use, and says why.
  const refused = await page.request.put('/api/settings/search', {
    data: { provider: 'codex', timeLimitSeconds: 2 },
  });
  expect(refused.status()).toBe(422);
});
