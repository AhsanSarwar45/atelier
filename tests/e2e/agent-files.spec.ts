import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('reads provider files, edits one in place and creates a missing one', async ({ page }) => {
  const codex = process.env.CODEX_HOME!;
  rmSync(join(codex, 'AGENTS.md'), { force: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings?section=files');
  await expect(page.getByTestId('settings-section-files')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('files-account')).toContainText('System');
  await expect(page.getByRole('heading', { name: 'Claude', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Codex', exact: true })).toBeVisible();
  await expect(page.getByTestId('agent-file-editor')).toContainText('# Personal instructions');
  await expect(page.getByTestId('agent-file-save')).toBeDisabled();
  await page.screenshot({ path: join(results, 'desktop.png'), fullPage: true });

  // Typing marks the file unsaved; Save writes exactly what is in the editor.
  await page.getByTestId('agent-file-editor').locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('- Say when a test was skipped.\n');
  await expect(page.getByTestId('agent-file-dirty')).toBeVisible();
  await page.getByTestId('agent-file-save').click();
  await expect(page.getByTestId('agent-file-dirty')).toBeHidden();
  await expect
    .poll(() => readFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'CLAUDE.md'), 'utf8'))
    .toContain('- Say when a test was skipped.');

  // A well-known file that is not there is offered, and one press makes it.
  expect(existsSync(join(codex, 'AGENTS.md'))).toBe(false);
  await page.getByTestId('agent-file-create-AGENTS.md').click();
  await expect.poll(() => existsSync(join(codex, 'AGENTS.md'))).toBe(true);
  await expect(page.getByTestId('agent-file-AGENTS.md')).toBeVisible();
});

test('uses file-list then reader navigation on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings?section=files');
  await expect(page.getByText('CLAUDE.md').first()).toBeVisible();
  await page.getByText('CLAUDE.md').first().click();
  await expect(page.getByRole('button', { name: 'Files' })).toBeVisible();
  await expect(page.getByTestId('agent-file-editor')).toContainText('# Personal instructions');
  await page.screenshot({ path: join(results, 'phone.png'), fullPage: true });
});
