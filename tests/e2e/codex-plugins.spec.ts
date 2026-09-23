import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * A Codex account has a Plugins page too (bw-anxb.3): its marketplaces, a
 * catalogue to install from, and a switch on every installed plugin. It is the
 * same page as Claude's; only the commands behind it are Codex's own.
 *
 * Codex reads a marketplace in Claude's layout as well as its own, so the
 * fixture marketplace the Claude case uses serves here unchanged, and nothing
 * here depends on reaching the network.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/codex-plugins.spec.ts
 */

const results = 'tests/results/codex-plugins';
const marketplace = resolve('tests/fixtures/plugin-marketplace');

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('a Codex account browses, installs, switches off and removes a plugin', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=codex&tab=plugins&account=system');
  await expect(page.getByTestId('extensions-plugins')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('marketplace-add').click();
  await page.getByTestId('marketplace-add-input').fill(marketplace);
  await page.getByTestId('marketplace-add-submit').click();
  await expect(page.getByTestId('extension-marketplaces-beads-web-fixture')).toBeVisible({ timeout: 60_000 });

  await page.getByTestId('plugin-browse').click();
  const tidy = page.getByTestId('plugin-entry-tidy-notes@beads-web-fixture');
  await expect(tidy).toBeVisible({ timeout: 30_000 });
  await expect(tidy).toContainText('beads-web-fixture');
  await page.screenshot({ path: join(results, 'catalogue.png') });

  await page.getByTestId('plugin-catalogue-install-tidy-notes@beads-web-fixture').click();
  await expect(page.getByTestId('plugin-catalogue')).toHaveCount(0, { timeout: 60_000 });
  const enabled = page.getByTestId('plugin-enabled-tidy-notes@beads-web-fixture');
  await expect(enabled).toBeChecked();
  await page.screenshot({ path: join(results, 'installed.png') });

  // Switched off, and still off when the page is read again.
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await page.reload();
  await expect(page.getByTestId('plugin-enabled-tidy-notes@beads-web-fixture')).not.toBeChecked({ timeout: 30_000 });

  await page.getByTestId('extension-remove-tidy-notes@beads-web-fixture').click();
  await expect(page.getByTestId('extension-plugins-tidy-notes@beads-web-fixture')).toHaveCount(0, { timeout: 60_000 });
});

test('the Codex account settings have a Plugins tab', async ({ page }) => {
  await page.goto('/settings?section=codex&account=system');
  await page.getByTestId('provider-tabs-codex').getByTestId('provider-tab-plugins').click();
  await expect(page.getByTestId('extensions-plugins')).toBeVisible({ timeout: 30_000 });
});
