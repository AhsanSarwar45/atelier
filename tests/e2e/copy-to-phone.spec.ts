import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * The Copy to… button is comfortable on a phone (bw-6ecp.4).
 *
 * The account picker and the button shared one row that never wrapped, and the
 * picker asks for the whole width below the small breakpoint, so on a phone the
 * two fought over it: at 320px the picker was down to 184px with the button
 * pressed against the right edge. Below that breakpoint the button now takes a
 * row of its own, full width; from it up nothing moves.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/copy-to-phone.spec.ts
 */

const results = 'tests/results/copy-to-phone';
const phone = { width: 390, height: 844 };

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('on a phone the button is under the picker and full width; on a desktop it is beside it', async ({ page, request }) => {
  // Copy to… is only offered when there is somewhere to copy to.
  const made = await request.post('/api/workbench/command', { data: { type: 'profile.create', brand: 'claude', name: 'Work' } });
  expect(made.ok(), await made.text()).toBeTruthy();

  await page.setViewportSize(phone);
  await page.goto('/settings?section=claude');
  const button = page.getByTestId('copy-to-accounts-claude');
  const picker = page.getByTestId('account-picker-claude');
  await expect(button).toBeVisible();

  let box = (await button.boundingBox())!;
  let pick = (await picker.boundingBox())!;
  await page.screenshot({ path: join(results, 'phone-header.png'), clip: { x: 0, y: 0, width: phone.width, height: 220 } });
  // Its own row, under the picker, and as wide as it.
  expect(box.y).toBeGreaterThanOrEqual(pick.y + pick.height);
  expect(box.width).toBeCloseTo(pick.width, 0);
  // The picker is no longer squeezed by it.
  expect(pick.width).toBeGreaterThan(phone.width - 48);

  // Still the button it was.
  await button.click();
  await expect(page.getByTestId('copy-to-accounts-dialog')).toBeVisible();
  await page.screenshot({ path: join(results, 'phone-dialog.png') });
  await page.keyboard.press('Escape');

  // On a wide screen the two are still on one row.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(button).toBeVisible();
  box = (await button.boundingBox())!;
  pick = (await picker.boundingBox())!;
  expect(box.y).toBeLessThan(pick.y + pick.height);
  expect(box.x).toBeGreaterThan(pick.x + pick.width - 1);
  await page.screenshot({ path: join(results, 'desktop-header.png'), clip: { x: 0, y: 0, width: 900, height: 220 } });
});
