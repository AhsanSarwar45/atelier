import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * A plugin is found in its marketplace's catalogue and installed in one click
 * (bw-6ecp.7).
 *
 * Installing one meant knowing both halves of `plugin@marketplace` and having
 * added the marketplace first — a thing you can only do if you already know
 * what is in it. Now the marketplaces are read for what they offer, shelved by
 * the category each entry declares, with Install on every row.
 *
 * The marketplace used here is a fixture in this repository, so the case says
 * nothing about whether this machine can reach GitHub. The ones Anthropic
 * publishes are fetched too and may add rows beside it; nothing here counts
 * rows, only that the fixture's own are there and installable.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/plugin-catalogue.spec.ts
 */

const results = 'tests/results/plugin-catalogue';
const marketplace = resolve('tests/fixtures/plugin-marketplace');

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('a plugin is found by shelf and by name, and installed in one click', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=claude&tab=plugins&account=system');
  await expect(page.getByTestId('extensions-plugins')).toBeVisible();

  // The account has a marketplace, added the way a reader would.
  await page.getByTestId('marketplace-add').click();
  await page.getByTestId('marketplace-add-input').fill(marketplace);
  await page.getByTestId('marketplace-add-submit').click();
  await expect(page.getByTestId('extension-marketplaces-beads-web-fixture')).toBeVisible({ timeout: 60_000 });

  // What it offers is listed, with what each plugin is for and where it is from.
  await page.getByTestId('plugin-browse').click();
  const sheet = page.getByTestId('plugin-catalogue');
  await expect(sheet).toBeVisible();
  const tidy = page.getByTestId('plugin-entry-tidy-notes@beads-web-fixture');
  await expect(tidy).toBeVisible({ timeout: 30_000 });
  await expect(tidy).toContainText('Tidy Notes');
  await expect(tidy).toContainText('Productivity');
  await expect(tidy).toContainText('beads-web-fixture');
  await page.screenshot({ path: join(results, 'catalogue.png') });

  // A shelf narrows it to its own…
  await page.getByTestId('plugin-shelf-productivity').click();
  await expect(page.getByTestId('plugin-entry-loud-logs@beads-web-fixture')).toHaveCount(0);
  await expect(tidy).toBeVisible();

  // …and a search is across everything, whatever shelf was ticked before it.
  await page.getByTestId('plugin-catalogue-search').fill('loud');
  await expect(page.getByTestId('plugin-entry-loud-logs@beads-web-fixture')).toBeVisible();
  await expect(tidy).toHaveCount(0);
  await page.screenshot({ path: join(results, 'searched.png') });

  // One click installs it, and it is on the account, switched on.
  await page.getByTestId('plugin-catalogue-install-loud-logs@beads-web-fixture').click();
  await expect(sheet).toHaveCount(0, { timeout: 60_000 });
  const installed = page.getByTestId('extension-plugins-loud-logs@beads-web-fixture');
  await expect(installed).toBeVisible();
  await expect(page.getByTestId('plugin-enabled-loud-logs@beads-web-fixture')).toBeChecked();
  await page.screenshot({ path: join(results, 'installed.png') });

  // Opened again, the catalogue says so rather than offering it twice.
  await page.getByTestId('plugin-browse').click();
  await expect(page.getByTestId('plugin-catalogue-install-loud-logs@beads-web-fixture')).toContainText('Installed', { timeout: 30_000 });
  await expect(page.getByTestId('plugin-catalogue-install-loud-logs@beads-web-fixture')).toBeDisabled();
});

test('on a phone the plugin catalogue is a sheet on the bottom edge', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings?section=claude&tab=plugins&account=system');
  await expect(page.getByTestId('extensions-plugins')).toBeVisible();
  await page.getByTestId('plugin-browse').click();

  const sheet = page.getByTestId('plugin-catalogue');
  await expect(sheet).toBeVisible();
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox();
      return box ? Math.round(box.y + box.height) : -1;
    })
    .toBe(844);
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(390);
  await expect(page.getByTestId('plugin-entry-tidy-notes@beads-web-fixture')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: join(results, 'phone.png') });
});
