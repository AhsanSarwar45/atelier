import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * Settings that have a known set of answers are dropdowns: language, output
 * style (including the account's own style files). The install guide link in
 * Dependencies is readable (bw-nin9.4, bw-nin9.5).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/settings-choices.spec.ts
 */

const results = 'tests/results/settings-choices';
const claudeDir = process.env.CLAUDE_CONFIG_DIR!;

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('language and output style are chosen from a list that includes the account\'s own styles', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  mkdirSync(join(claudeDir, 'output-styles'), { recursive: true });
  writeFileSync(join(claudeDir, 'output-styles', 'Terse.md'), '---\nname: Terse\n---\nSay less.\n');

  await page.goto('/settings?section=claude');
  await page.locator('#setting-claude-language').click();
  await page.getByRole('option', { name: 'Japanese' }).click();
  await expect.poll(() => JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).language).toBe('Japanese');

  await page.locator('#setting-claude-outputStyle').click();
  await expect(page.getByRole('option', { name: /^Terse/ })).toBeVisible();
  await page.waitForTimeout(400); // the list finishes opening
  await page.screenshot({ path: join(results, 'desktop-output-styles.png') });
  await page.getByRole('option', { name: /^Terse/ }).click();
  await expect.poll(() => JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).outputStyle).toBe('Terse');
});

test('the install guide link is readable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings?section=dependencies');
  const link = page.getByRole('link', { name: /Install guide/ }).first();
  await expect(link).toBeVisible();
  const colour = await link.evaluate((el) => getComputedStyle(el).color);
  // The old accent ink on the dark skin was near the panel's own colour.
  expect(colour).not.toBe('rgb(39, 39, 42)');
  await page.screenshot({ path: join(results, 'desktop-dependencies.png') });
});
