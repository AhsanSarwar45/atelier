import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * Skipping a version is an answer the server keeps.
 *
 * The notice used to offer only "not now", which meant this page and nothing
 * more: the next load asked again, and the only way to stop being asked was to
 * take the update. Skipping names one version, is held by the server so the
 * phone stops asking too, and is taken back in About — where the update is
 * still offered, because skipping is about being told, not about being able to
 * (bw-p4le).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-skipped-version-stays-skipped.spec.ts
 */

const results = 'tests/results/skipped-version';

/** A release waiting, so there is something to skip. */
const WAITING = {
  current: '0.15.0',
  latest: '0.16.0',
  update_available: true,
  download_url: 'https://example.invalid/release',
  release_notes: 'Fixed the thing.',
  asset_url: 'https://example.invalid/asset',
  checksums_url: 'https://example.invalid/sums',
};

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  // There is usually no newer release, so the run answers the version question
  // itself — but it leaves the skipped version to the real server, which is
  // the thing under test. The route reads the server's answer and puts the
  // release on top of it.
  await page.route('**/api/version/check*', async (route) => {
    const said = await route.fetch();
    const mine = (await said.json()) as Record<string, unknown>;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...mine, ...WAITING }),
    });
  });
});

test.afterEach(async ({ page }) => {
  // A check still in flight when the case ends fails the run on a route
  // callback rather than on anything the case was proving.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // Every case leaves the setting as it found it, so a later run does not
  // start out already skipped.
  await page.request.put('/api/settings/update', { data: { skippedVersion: null } });
});

test('a version skipped in About stays skipped after a reload, and can be taken back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.put('/api/settings/update', { data: { skippedVersion: null } });

  await page.goto('/settings?section=about');
  await expect(page.getByTestId('about-settings')).toBeVisible();
  await expect(page.getByTestId('about-update-now')).toBeVisible();
  await page.screenshot({ path: join(results, 'before.png') });

  await page.getByTestId('about-skip').click();
  await expect(page.getByTestId('about-skipped')).toContainText('v0.16.0');

  await page.reload();
  const skipped = page.getByTestId('about-skipped');
  await expect(skipped).toContainText('v0.16.0');
  // Still offered here. The reader said "stop telling me", not "never".
  await expect(page.getByTestId('about-update-now')).toBeVisible();
  await page.screenshot({ path: join(results, 'after.png') });

  await page.getByTestId('about-unskip').click();
  await expect(skipped).toBeHidden();
  await page.reload();
  await expect(page.getByTestId('about-skipped')).toBeHidden();
  await expect(page.getByTestId('about-skip')).toBeVisible();
});

test('the notice goes quiet for a skipped version and speaks up for a newer one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.put('/api/settings/update', { data: { skippedVersion: null } });

  await page.goto('/');
  const notice = page.getByTestId('update-banner');
  await expect(notice).toBeVisible();
  await notice.getByTestId('update-skip').click();
  await expect(notice).toBeHidden();

  // A reload is the whole point: dismissing lasts until the page goes away,
  // skipping outlives it.
  await page.reload();
  await expect(page.getByTestId('update-banner')).toBeHidden();

  // A newer release is news again, because the skip named 0.16.0 and not the
  // idea of updating.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/api/version/check*', async (route) => {
    const said = await route.fetch();
    const mine = (await said.json()) as Record<string, unknown>;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...mine, ...WAITING, latest: '0.17.0' }),
    });
  });
  await page.reload();
  await expect(page.getByTestId('update-banner')).toContainText('v0.17.0');
  await page.screenshot({ path: join(results, 'newer-release.png') });
});

test('the server refuses a skip that is not a version', async ({ page }) => {
  // The setting is the one thing that can silence the notice for good, so it
  // holds a version or nothing. A stray word stored here would be a silent
  // off-switch nobody could find again.
  await page.goto('/settings?section=about');
  const refused = await page.request.put('/api/settings/update', {
    data: { skippedVersion: 'latest' },
  });
  expect(refused.status()).toBe(422);
});
