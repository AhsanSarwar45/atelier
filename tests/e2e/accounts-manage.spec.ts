import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * An account is renamed and starred from Accounts, and a provider page is
 * copied from one account into another (bw-2t1c.11).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/accounts-manage.spec.ts
 */

const results = 'tests/results/accounts-manage';

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('an account is renamed, starred, and given a copy of another account\'s defaults', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // A second Claude account, made without the sign-in that follows adding one on screen.
  // A name no other case uses: every case runs against one instance, and the
  // server refuses a second account of the same brand and name (bw-6ecp.18).
  const made = await request.post('/api/workbench/command', { data: { type: 'profile.create', brand: 'claude', name: 'Renamed' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const { profile } = (await made.json()) as { profile: { id: string } };
  const id = profile.id;

  await page.goto('/settings?section=accounts');
  await expect(page.getByTestId(`account-claude-${id}`)).toBeVisible();

  await page.getByTestId(`account-rename-claude-${id}`).click();
  await page.getByTestId(`account-rename-input-claude-${id}`).fill('Work laptop');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`account-claude-${id}`)).toContainText('Work laptop');

  await page.getByTestId(`account-default-claude-${id}`).click();
  await expect(page.getByTestId(`account-default-claude-${id}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('account-default-claude-system')).toHaveAttribute('aria-pressed', 'false');
  const defaults = await page.request.get('/api/settings/new-chat');
  expect(((await defaults.json()) as { profiles: Record<string, string> }).profiles.claude).toBe(id);
  await page.screenshot({ path: join(results, 'desktop-accounts.png') });

  // The system account's defaults, copied into the new one.
  await page.goto('/settings?section=claude');
  await page.locator('#setting-claude-effortLevel').click();
  await page.getByRole('option', { name: /^Medium/ }).click();
  await expect(page.locator('#setting-claude-effortLevel')).toContainText('Medium');
  await page.getByTestId('copy-to-accounts-claude').click();
  await page.getByTestId(`copy-to-${id}`).click();
  await page.screenshot({ path: join(results, 'desktop-copy.png') });
  await page.getByTestId('copy-to-accounts-confirm').click();
  await expect(page.getByTestId('copy-to-accounts-dialog')).toHaveCount(0);
  const profileDir = join(process.env.ATELIER_DATA_DIR!, 'profiles', 'claude', id);
  await expect.poll(() => {
    try {
      return JSON.parse(readFileSync(join(profileDir, 'settings.json'), 'utf8')).effortLevel as string;
    } catch {
      return null;
    }
  }).toBe('medium');

  await page.getByTestId('account-picker-claude').click();
  await page.getByRole('option', { name: 'Work laptop' }).click();
  await expect(page.locator('#setting-claude-effortLevel')).toContainText('Medium');
});
