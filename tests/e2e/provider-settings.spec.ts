import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * A provider's settings are edited in place, per account, and land in that
 * account's own file: Claude's `settings.json`, Codex's `config.toml`. The
 * account and the tab are in the address so a link opens the same page
 * (bw-2t1c.4, bw-2t1c.5).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/provider-settings.spec.ts
 */

const results = 'tests/results/provider-settings';
const claudeDir = process.env.CLAUDE_CONFIG_DIR!;
const codexHome = process.env.CODEX_HOME!;

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('a Claude Code default is written to the account settings file', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings?section=claude');
  await expect(page.getByTestId('provider-section-claude')).toBeVisible();
  await expect(page.getByTestId('account-picker-claude')).toBeVisible();
  await expect(page.getByTestId('provider-settings-claude-defaults')).toBeVisible();

  await page.locator('#setting-claude-effortLevel').click();
  await page.getByRole('option', { name: /^High/ }).click();
  await expect(page.locator('#setting-claude-effortLevel')).toContainText('High');
  await expect.poll(() => JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).effortLevel).toBe('high');

  await page.getByTestId('provider-tab-permissions').click();
  await expect(page).toHaveURL(/tab=permissions/);
  await expect(page.getByTestId('provider-settings-claude-permissions')).toBeVisible();
  await page.locator('#setting-claude-permissions-defaultMode').click();
  await page.getByRole('option', { name: /Accept edits/ }).click();
  await expect
    .poll(() => JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).permissions?.defaultMode)
    .toBe('acceptEdits');
  await page.screenshot({ path: join(results, 'claude-desktop.png') });

  // Not set removes the key rather than writing an empty value.
  await page.locator('#setting-claude-permissions-defaultMode').click();
  await page.getByRole('option', { name: 'Not set' }).click();
  await expect
    .poll(() => JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).permissions?.defaultMode)
    .toBeUndefined();
});

test('a Codex default is written to config.toml, and the file is created on first change', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings?section=codex');
  await expect(page.getByTestId('provider-settings-codex-defaults')).toBeVisible();

  await page.locator('#setting-codex-model_reasoning_effort').click();
  await page.getByRole('option', { name: /^High/ }).click();
  await expect.poll(() => existsSync(join(codexHome, 'config.toml'))).toBe(true);
  await expect.poll(() => readFileSync(join(codexHome, 'config.toml'), 'utf8')).toMatch(/model_reasoning_effort = "high"/);

  await page.getByTestId('provider-tab-permissions').click();
  await page.locator('#setting-codex-approval_policy').click();
  await page.getByRole('option', { name: /Never/ }).click();
  await expect.poll(() => readFileSync(join(codexHome, 'config.toml'), 'utf8')).toMatch(/approval_policy = "never"/);
  await page.screenshot({ path: join(results, 'codex-desktop.png') });
});

test('a phone gets the account, the tabs and the rows in one column', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/settings?section=claude&tab=permissions');
  await expect(page.getByTestId('provider-settings-claude-permissions')).toBeVisible();
  await expect(page.getByTestId('settings-nav')).toBeHidden();
  await page.screenshot({ path: join(results, 'claude-phone.png'), fullPage: true });
});
