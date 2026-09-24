import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('delete exact agent files in global and project settings', async ({ page, request }) => {
  const root = process.env.WORKBENCH_E2E_RUN!;
  const projectPath = join(root, 'delete-project');
  mkdirSync(projectPath, { recursive: true });
  const created = await request.post('/api/projects', { data: { name: 'Agent file deletion', path: projectPath } });
  expect(created.ok()).toBeTruthy();
  const project = await created.json();
  const globalFile = join(process.env.CLAUDE_CONFIG_DIR!, 'CLAUDE.md');
  const projectFile = join(projectPath, 'CLAUDE.md');
  writeFileSync(globalFile, '# Global deletion fixture\n');
  writeFileSync(projectFile, '# Project deletion fixture\n');
  const results = 'tests/results/agent-files-delete';
  mkdirSync(results, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [scope, url, file] of [
    ['global', '/settings?section=files', globalFile],
    ['project', `/project?id=${project.id}&settings=files`, projectFile],
  ]) {
    await page.goto(url);
    const row = page.getByTestId('agent-file-CLAUDE.md');
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByTestId('agent-file-editor')).toContainText('deletion fixture');
    if (process.env.AGENT_DELETE_BEFORE === '1') {
      await page.screenshot({ path: join(results, `${scope}-before.png`), fullPage: true });
      continue;
    }
    await row.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Delete file' })).toBeVisible();
    await page.screenshot({ path: join(results, `${scope}-menu-after.png`), fullPage: true, animations: 'disabled' });
    await page.getByRole('menuitem', { name: 'Delete file' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(file);
    await page.screenshot({ path: join(results, `${scope}-confirm.png`), animations: 'disabled' });
    // The box and the dim behind it are painted, not left see-through: the
    // library dialog once named colours this app never defines (bw-weih.1).
    const painted = (el: Element) => {
      const { backgroundColor } = getComputedStyle(el);
      return backgroundColor !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(backgroundColor);
    };
    expect(await confirm.evaluate(painted)).toBe(true);
    expect(await page.locator('[data-slot="alert-dialog-overlay"]').evaluate(painted)).toBe(true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(existsSync(file)).toBe(true);
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete file' }).click();
    await page.getByRole('button', { name: 'Delete file', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByText('No file selected')).toBeVisible();
    expect(existsSync(file)).toBe(false);
    await expect(page.getByTestId('agent-file-create-CLAUDE.md')).toBeVisible();
  }
  if (process.env.AGENT_DELETE_BEFORE === '1') {
    await page.goto('/settings?section=claude');
    await expect(page.getByText('Output style', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(results, 'claude-style-before.png'), fullPage: true });
  }
});
