import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * A control offers what the provider accepts, and writes what it accepts.
 *
 * The audit drove every control on both providers' screens and found that the
 * round trip was sound — what was written came back — while several of the
 * values written were ones the provider rejects, and one control could destroy
 * what was already in the file (docs/audits/settings-2026-09-18.md). These are
 * those cases (bw-6ecp.8 through .15).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/settings-values.spec.ts
 */

const results = 'tests/results/settings-values';
const claudeDir = process.env.CLAUDE_CONFIG_DIR!;
const codexHome = process.env.CODEX_HOME!;

// Several of these edit the same account's settings file, so they take turns.
test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

const claudeSettings = () => JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));

test('the unsandboxed-retry setting writes the boolean Claude Code reads', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=claude&tab=permissions');
  const control = page.locator('#setting-claude-sandbox-allowUnsandboxedCommands');
  await expect(control).toBeVisible();
  // Not "retry" or "forbid", neither of which Claude Code accepts.
  await control.click();
  await page.getByRole('option', { name: 'Off' }).click();
  await expect.poll(() => claudeSettings().sandbox?.allowUnsandboxedCommands).toBe(false);
  await control.click();
  await page.getByRole('option', { name: 'On' }).click();
  await expect.poll(() => claudeSettings().sandbox?.allowUnsandboxedCommands).toBe(true);
  await page.screenshot({ path: join(results, 'desktop-claude-sandbox.png') });
});

test('Codex is not offered a model it has retired', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=codex');
  await page.locator('#setting-codex-model').click();
  for (const gone of ['GPT-5.4', 'GPT-5.4 mini', 'GPT-5.3 Codex Spark']) {
    await expect(page.getByRole('option', { name: gone, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('option', { name: /GPT-6 Astra/ })).toBeVisible();
  // 5.5 still runs until 14 October 2026, and says so.
  await expect(page.getByRole('option', { name: /GPT-5.5/ })).toContainText('Retires 14 Oct 2026');
  await page.screenshot({ path: join(results, 'desktop-codex-models.png') });
});

test('the two modes a project file cannot turn on are offered only on the account', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=claude&tab=permissions');
  await page.locator('#setting-claude-permissions-defaultMode').click();
  await expect(page.getByRole('option', { name: /Auto/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Bypass/ })).toBeVisible();
  await page.keyboard.press('Escape');

  const repo = mkdtempSync(join(tmpdir(), 'atelier-modes-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const made = await request.post('/api/projects', { data: { name: 'Modes', path: repo } });
  expect(made.status(), await made.text()).toBe(201);
  const { id } = (await made.json()) as { id: string };
  await page.goto(`/project?id=${id}&settings=claude&ptab=permissions`);
  await page.locator('#setting-claude-permissions-defaultMode').click();
  // Claude Code ignores these two from a project or local file, without a word.
  await expect(page.getByRole('option', { name: /Auto/ })).toHaveCount(0);
  await expect(page.getByRole('option', { name: /Bypass/ })).toHaveCount(0);
  // The rest of the list is honoured there and is still offered.
  await expect(page.getByRole('option', { name: /Accept edits/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Plan/ })).toBeVisible();
  await page.screenshot({ path: join(results, 'desktop-project-modes.png') });
});
