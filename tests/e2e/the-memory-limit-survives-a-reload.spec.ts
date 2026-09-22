import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * The memory limit a chat is held to is set in Settings, is unset until
 * somebody sets it, and is still set after a reload because the server holds
 * it — the server is what watches the processes (bw-qg8r.1).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-memory-limit-survives-a-reload.spec.ts
 */

const results = 'tests/results/memory-limit';

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('a chat memory limit is set, survives a reload, and can be cleared', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings?section=memory');
  const field = page.getByTestId('memory-limit');
  await expect(page.getByTestId('memory-settings')).toBeVisible();

  // Nobody has set one: the field is empty and says so.
  await expect(field).toHaveValue('');
  await expect(field).toHaveAttribute('placeholder', 'No limit');
  await page.screenshot({ path: join(results, 'no-limit.png') });

  await field.fill('8');
  await field.blur();
  await expect(field).toHaveValue('8');

  await page.reload();
  await expect(page.getByTestId('memory-limit')).toHaveValue('8');
  await page.screenshot({ path: join(results, 'limit-set.png') });

  // The server holds it, not the browser.
  const held = await page.request.get('/api/settings/memory');
  expect(await held.json()).toEqual({ limitGb: 8 });

  // A limit no chat could ever start under is refused, and the old one stands.
  const refused = await page.request.put('/api/settings/memory', { data: { limitGb: 0.01 } });
  expect(refused.status()).toBe(422);
  expect(await (await page.request.get('/api/settings/memory')).json()).toEqual({ limitGb: 8 });

  // Emptying the field is how a limit is taken off again.
  await page.getByTestId('memory-limit').fill('');
  await page.getByTestId('memory-limit').blur();
  await page.reload();
  await expect(page.getByTestId('memory-limit')).toHaveValue('');
  expect(await (await page.request.get('/api/settings/memory')).json()).toEqual({ limitGb: null });
});
