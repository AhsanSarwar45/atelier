import { readFileSync } from 'node:fs';
import { chromium, expect, test as base } from '@playwright/test';
import type { UpdateRun } from '../../src/lib/update-run';

// Connect only to the private Chrome started with `atelier tool chrome up`.
const test = base.extend({
  browser: [async ({}, use) => {
    if (!process.env.CDP_URL) throw new Error('Start private Chrome with atelier tool chrome up and export atelier tool chrome env before this test.');
    const browser = await chromium.connectOverCDP(process.env.CDP_URL);
    await use(browser);
  }, { scope: 'worker' }],
});

const staleBrew: UpdateRun = {
  phase: 'failed', received: 0, total: null, note: null,
  failed: "Couldn't update to 0.25.2. Homebrew still has 0.25.1 installed. Try again after the Homebrew release is available.",
  version: '0.25.2',
};

/**
 * The package manager pipeline is exercised with real fixture executables by
 * routes::version::tests. This browser case exercises the existing live-wire
 * and retry UI without ever upgrading or restarting the hosting installation.
 * UPDATE_REGRESSION_STATE may supply the actual serialized native-test frame.
 */
test('a Homebrew no-op displays failure and permits retry without reloading', async ({ page }) => {
  const failed = process.env.UPDATE_REGRESSION_STATE
    ? JSON.parse(readFileSync(process.env.UPDATE_REGRESSION_STATE, 'utf8'))
    : staleBrew;
  expect(failed.phase).toBe('failed');
  expect(failed.failed).toContain('0.25.1');
  expect(failed.failed).toContain('0.25.2');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let navigationCount = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigationCount++; });
  const sockets = new Set<{ send: (message: string) => void }>();
  const emit = (state: UpdateRun) => {
    for (const socket of sockets) socket.send(JSON.stringify({ tag: 'update', data: JSON.stringify(state) }));
  };
  await page.routeWebSocket(/\/api\/live/, socket => {
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    socket.send(JSON.stringify({ tag: 'update', data: JSON.stringify({ ...staleBrew, phase: 'idle', failed: null }) }));
  });
  await page.route('**/api/version/check*', route => route.fulfill({ json: {
    current: '0.25.1', latest: '0.25.2', update_available: true,
    install_method: 'homebrew', skipped_version: null, release_notes: null,
    download_url: null, asset_url: null, checksums_url: null,
  } }));
  let requests = 0;
  let finish: (() => void) | undefined;
  await page.route('**/api/update', async route => {
    requests++;
    await route.fulfill({ status: 202, json: { status: 'started' } });
    finish = () => emit(failed);
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings?section=about');
  const about = page.getByTestId('about-settings');
  await expect(about.getByTestId('about-update-now')).toBeVisible();
  await about.getByTestId('about-update-now').click();
  await expect.poll(() => requests).toBe(1);
  await expect(about.getByTestId('about-update-now')).toHaveText('Updating…');
  // Old success event: capture the misleading restart state, then immediately
  // send failure so the test never asks the browser to reload.
  emit({ ...staleBrew, phase: 'restarting', failed: null });
  await expect(about.getByTestId('about-progress')).toContainText('Restarting');
  await page.screenshot({ path: '/tmp/task1-update-before.png' });
  finish!();
  await expect(about.getByTestId('about-update-error')).toHaveText(failed.failed);
  await expect(about.getByTestId('about-progress')).toContainText('Update failed');
  await expect(page.getByTestId('update-error')).toHaveText(failed.failed);
  await expect(about.getByTestId('about-update-now')).toHaveText('Try again');
  await expect(about.getByTestId('about-update-now')).toBeEnabled();
  const navigationsAtFailure = navigationCount;
  await page.waitForTimeout(4100);
  expect(navigationCount).toBe(navigationsAtFailure);
  await page.screenshot({ path: '/tmp/task1-update-after.png' });
  await about.getByTestId('about-update-now').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => requests).toBe(2);
  await expect(about.getByTestId('about-update-error')).toBeHidden();
  await expect(about.getByTestId('about-update-now')).toBeDisabled();
  finish!();
  await expect(about.getByTestId('about-update-error')).toHaveText(failed.failed);
  for (const width of [390, 768, 1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(about.getByTestId('about-update-error')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/task1-update-${width}.png` });
  }
  expect((await page.request.get('/api/health')).ok()).toBe(true);
  expect(errors).toEqual([]);
});
