import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const results = 'tests/results/agent-files';

test.beforeAll(() => {
  const claude = process.env.CLAUDE_CONFIG_DIR!;
  const codex = process.env.CODEX_HOME!;
  mkdirSync(join(claude, 'agents'), { recursive: true });
  mkdirSync(join(claude, 'skills', 'review', 'scripts'), { recursive: true });
  mkdirSync(join(claude, 'skills', 'synced', 'bundle-1a600a93', 'docx'), { recursive: true });
  mkdirSync(join(codex, 'agents'), { recursive: true });
  writeFileSync(join(claude, 'CLAUDE.md'), '# Personal instructions\n\n- Prefer focused changes.\n- Run the relevant tests.\n');
  writeFileSync(join(claude, 'settings.json'), '{\n  "model": "sonnet"\n}\n');
  writeFileSync(join(claude, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview changed code.\n');
  writeFileSync(join(claude, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a change\n---\nReview carefully.\n');
  // What a real skill carries beside its SKILL.md, and what a marketplace
  // sync leaves under `synced`. Neither is a thing anyone edits here.
  writeFileSync(join(claude, 'skills', 'review', 'LICENSE.txt'), 'MIT\n');
  writeFileSync(join(claude, 'skills', 'review', 'scripts', 'review.py'), 'pass\n');
  writeFileSync(join(claude, 'skills', 'synced', 'bundle-1a600a93', 'docx', 'SKILL.md'), '---\nname: docx\n---\nWrite Word files.\n');
  writeFileSync(join(claude, 'skills', 'synced', 'bundle-1a600a93', 'manifest.json'), '{}\n');
  writeFileSync(join(claude, 'skills', 'synced', '.bucket-1a600a93'), '\n');
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
  // One place, one choice: the account above, the search box, and no scope chips
  // or project dropdown; the list and the editor share the whole width (bw-76eu).
  await expect(page.getByLabel('Filter by scope')).toHaveCount(0);
  await expect(page.getByLabel('Project scope')).toHaveCount(0);
  const list = (await page.getByRole('complementary', { name: 'Agent files' }).boundingBox())!;
  const editor = (await page.getByTestId('agent-file-editor').boundingBox())!;
  expect(editor.width).toBeGreaterThanOrEqual(list.width);
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

test('a provider has no Files tab; its files are under Agent files', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings?section=claude');
  await expect(page.getByTestId('provider-tab-mcp')).toBeVisible();
  await expect(page.getByTestId('provider-tab-files')).toHaveCount(0);
  await page.goto('/settings?section=codex');
  await expect(page.getByTestId('provider-tab-mcp')).toBeVisible();
  await expect(page.getByTestId('provider-tab-files')).toHaveCount(0);
});

test('uses file-list then reader navigation on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings?section=files');
  await expect(page.getByText('CLAUDE.md').first()).toBeVisible();
  await page.getByText('CLAUDE.md').first().click();
  await expect(page.getByRole('button', { name: 'All files' })).toBeVisible();
  await expect(page.getByTestId('agent-file-editor')).toContainText('# Personal instructions');

  // The name is the one thing the header must say in full: the buttons used to
  // squeeze it to "CL…", and the format was spelled out beside it (bw-5j2e.1).
  const name = page.getByTestId('agent-file-name');
  await expect(name).toHaveText('CLAUDE.md');
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.getByText('MARKDOWN')).toHaveCount(0);

  // Name and actions share the one row: the header is a line, not a band.
  const line = async (testid: string) => (await page.getByTestId(testid).boundingBox())!;
  const nameBox = await line('agent-file-name');
  const saveBox = await line('agent-file-save');
  expect(Math.abs(nameBox.y - saveBox.y)).toBeLessThan(saveBox.height);
  await page.screenshot({ path: join(results, 'phone.png'), fullPage: true });
});

test('a skill is one row named for the skill, not every file inside it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings?section=files');
  const list = page.getByRole('complementary', { name: 'Agent files' });
  // Pictured before anything is asserted, so a run against the old discovery
  // still leaves the screenful it drew.
  await expect(list.getByTestId('agent-file-CLAUDE.md')).toBeVisible();
  await expect(list.getByText('Skills').first()).toBeVisible();
  await page.screenshot({ path: join(results, 'skills.png'), fullPage: true });
  await expect(list.getByTestId('agent-file-review')).toBeVisible();

  // The skill's own assets, and the marketplace's copies under `synced`, used
  // to be rows of their own — two hundred of them on a real machine, most
  // titled `SKILL.md` (bw-xnvs.1).
  await expect(list.getByTestId('agent-file-SKILL.md')).toHaveCount(0);
  await expect(list.getByTestId('agent-file-LICENSE.txt')).toHaveCount(0);
  await expect(list.getByTestId('agent-file-review.py')).toHaveCount(0);
  await expect(list.getByTestId('agent-file-manifest.json')).toHaveCount(0);
  await expect(list.getByTestId('agent-file-docx')).toHaveCount(0);
  await expect(list.getByText('synced')).toHaveCount(0);

  // The row opens the skill's own text, and the title is the skill.
  await list.getByTestId('agent-file-review').click();
  await expect(page.getByTestId('agent-file-name')).toHaveText('review');
  await expect(page.getByTestId('agent-file-editor')).toContainText('Review carefully.');
});
