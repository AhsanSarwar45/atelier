import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const results = 'tests/results/agent-files';

test.beforeAll(() => {
  const claude = process.env.CLAUDE_CONFIG_DIR!;
  const codex = process.env.CODEX_HOME!;
  mkdirSync(join(claude, 'agents'), { recursive: true });
  mkdirSync(join(claude, 'skills', 'review'), { recursive: true });
  mkdirSync(join(codex, 'agents'), { recursive: true });
  writeFileSync(join(claude, 'CLAUDE.md'), '# Personal instructions\n\n- Prefer focused changes.\n- Run the relevant tests.\n');
  writeFileSync(join(claude, 'settings.json'), '{\n  "model": "sonnet"\n}\n');
  writeFileSync(join(claude, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview changed code.\n');
  writeFileSync(join(claude, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a change\n---\nReview carefully.\n');
  writeFileSync(join(codex, 'AGENTS.md'), '# Codex instructions\n\nKeep reports concise.\n');
  writeFileSync(join(codex, 'config.toml'), 'model = "gpt-5.6-sol"\n');
  writeFileSync(join(codex, 'agents', 'researcher.toml'), 'name = "researcher"\nsandbox_mode = "read-only"\n');
  mkdirSync(results, { recursive: true });
});

test('reads provider files without editing them', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/agent-files');
  await expect(page.getByRole('heading', { name: 'Agent files' })).toBeVisible();
  await expect(page.getByText('Claude', { exact: true })).toBeVisible();
  await expect(page.getByText('Codex', { exact: true })).toBeVisible();
  await expect(page.locator('pre')).toContainText('# Personal instructions');
  await expect(page.getByRole('button', { name: /save/i })).toHaveCount(0);
  await page.screenshot({ path: join(results, 'desktop.png'), fullPage: true });
});

test('uses file-list then reader navigation on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings/agent-files');
  await expect(page.getByText('CLAUDE.md').first()).toBeVisible();
  await page.getByText('CLAUDE.md').first().click();
  await expect(page.getByRole('button', { name: 'Files' })).toBeVisible();
  await expect(page.locator('pre')).toContainText('# Personal instructions');
  await page.screenshot({ path: join(results, 'phone.png'), fullPage: true });
});
