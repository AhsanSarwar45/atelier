import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * The settings screen is one screen of sections, the open one in the address.
 *
 * A wide screen keeps the list beside the section; a phone shows the list,
 * then the section over it with its own way back. Pressing a section pushes
 * `?section=`, so the browser's Back steps out of it. The bar's arrow gives
 * back the page the reader came from rather than reloading the front door
 * (bw-2t1c.1, bw-2t1c.2).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/settings-sections.spec.ts
 */

const results = 'tests/results/settings-sections';

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('a wide screen keeps the list beside the open section, and Back steps between sections', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings');
  await expect(page.getByTestId('settings-nav')).toBeVisible();
  await expect(page.getByTestId('appearance-theme')).toBeVisible();

  await page.getByTestId('settings-section-tags').click();
  await expect(page).toHaveURL(/section=tags/);
  await expect(page.getByRole('heading', { name: 'Tags' })).toBeVisible();
  await expect(page.getByTestId('settings-nav')).toBeVisible();
  await page.screenshot({ path: join(results, 'desktop.png') });

  await page.goBack();
  await expect(page).not.toHaveURL(/section=/);
  await expect(page.getByTestId('appearance-theme')).toBeVisible();
});

test('a phone shows the list, then the section over it, with a way back to the list', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/settings');
  await expect(page.getByTestId('settings-nav')).toBeVisible();
  await expect(page.getByTestId('settings-body')).toBeHidden();
  await page.screenshot({ path: join(results, 'phone-list.png') });

  await page.getByTestId('settings-section-tags').click();
  await expect(page).toHaveURL(/section=tags/);
  await expect(page.getByTestId('settings-nav')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Tags' }).first()).toBeVisible();
  await page.screenshot({ path: join(results, 'phone-section.png') });

  await page.getByTestId('settings-sections').click();
  await expect(page).not.toHaveURL(/section=/);
  await expect(page.getByTestId('settings-nav')).toBeVisible();
});

test('the arrow gives back the page the reader came from, however many sections were opened', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings/);
  await page.getByTestId('settings-section-codex').click();
  await expect(page).toHaveURL(/section=codex/);
  await page.getByTestId('provider-tab-permissions').click();
  await expect(page).toHaveURL(/tab=permissions/);
  await page.getByTestId('settings-section-accounts').click();
  await expect(page).toHaveURL(/section=accounts/);
  await page.getByTestId('back-arrow').click();
  await expect(page).toHaveURL(/\/$/);
});

test('the old agent-files address still opens the files', async ({ page }) => {
  await page.goto('/settings/agent-files');
  await expect(page).toHaveURL(/section=files/);
  await expect(page.getByTestId('settings-section-files')).toHaveAttribute('aria-current', 'page');
});
