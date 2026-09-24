import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('edit a complete skill without losing scripts, assets or native metadata', async ({ page, request }) => {
  if (process.env.ATELIER_BROWSER_INSPECT) test.setTimeout(90_000);
  const run = process.env.WORKBENCH_E2E_RUN!;
  const locations = JSON.parse(execFileSync(process.env.ATELIER_BINARY!, ['tool', 'skills', 'locations', '--project', run], { encoding: 'utf8' }));
  const folder = join(locations.global.skills, 'editing-proof');
  mkdirSync(join(folder, 'assets'), { recursive: true });
  mkdirSync(join(folder, 'scripts'), { recursive: true });
  const binary = Buffer.from([0, 255, 17, 128]);
  const helper = 'print("preserved")\n';
  writeFileSync(join(folder, 'assets/data.bin'), binary);
  writeFileSync(join(folder, 'scripts/proof.py'), helper);
  writeFileSync(join(folder, 'SKILL.md'), '---\nname: Editing proof\ndescription: A complete reusable skill.\nlicense: MIT\nmetadata:\n  author: Original author\n---\nOriginal instructions with {{subject}}.\n');
  writeFileSync(join(folder, 'atelier.json'), JSON.stringify({ parameters: { subject: 'the project' } }));
  try {
    await page.goto('/settings?section=library');
    await page.getByRole('radio', { name: 'Skills', exact: true }).click();
    const row = page.getByTestId('library-item-editing-proof');
    await expect(row).toContainText('Editing proof');
    await page.screenshot({ path: `tests/results/shared-library/folder-editor-${process.env.ATELIER_CAPTURE_BEFORE ? 'before' : 'after'}.png`, animations: 'disabled' });
    if (process.env.ATELIER_CAPTURE_BEFORE) return;
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByLabel('Item content', { exact: true })).toHaveValue('Original instructions with {{subject}}.');
    await page.getByLabel('Item name', { exact: true }).fill('Edited proof');
    await page.getByLabel('Item content', { exact: true }).fill('Updated instructions for {{subject}}.');
    await page.getByRole('button', { name: 'Save item', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
    await page.reload();
    await page.getByRole('radio', { name: 'Skills', exact: true }).click();
    await expect(row).toContainText('Edited proof');
    expect(readFileSync(join(folder, 'assets/data.bin'))).toEqual(binary);
    expect(readFileSync(join(folder, 'scripts/proof.py'), 'utf8')).toBe(helper);
    expect(readFileSync(join(folder, 'SKILL.md'), 'utf8')).toContain('Original author');
    const api = '/api/settings/library/skill?id=editing-proof';
    const held = await (await request.get(api)).json();
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Item content', { exact: true }).fill('Draft must not overwrite a newer save.');
    writeFileSync(join(folder, 'SKILL.md'), readFileSync(join(folder, 'SKILL.md'), 'utf8') + '\nExternal edit.\n');
    await page.getByRole('button', { name: 'Save item', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('Item content', { exact: true })).toHaveValue('Draft must not overwrite a newer save.');
    const stale = await request.put(api, { data: held });
    expect(stale.status()).toBe(409);
    expect(readFileSync(join(folder, 'SKILL.md'), 'utf8')).toContain('External edit.');
    await page.getByRole('button', { name: 'Discard draft and reload' }).click();
    if (process.env.ATELIER_BROWSER_INSPECT) await page.waitForTimeout(50_000);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('project folder edits and global customizations remain in their own scopes', async ({ page, request }) => {
  test.skip(!!process.env.ATELIER_CAPTURE_BEFORE);
  const run = process.env.WORKBENCH_E2E_RUN!;
  const root = mkdtempSync(join(run, 'edit-project-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const project = await (await request.post('/api/projects', { data: { name: 'Folder editor project', path: root } })).json();
  await request.get(`/api/projects/${project.id}/settings`);
  const locations = JSON.parse(execFileSync(process.env.ATELIER_BINARY!, ['tool', 'skills', 'locations', '--project', root], { encoding: 'utf8' }));
  const global = join(locations.global.skills, 'edit-global');
  const local = join(locations.project.skills, 'edit-local');
  for (const folder of [global, local]) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), '---\nname: Scope proof\ndescription: Scope-specific procedure\n---\nOriginal scoped text.\n');
  }
  try {
    await page.goto(`/project?id=${project.id}&settings=library`);
    await page.getByRole('radio', { name: 'Skills', exact: true }).click();
    await page.getByTestId('library-item-edit-local').getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Item content', { exact: true }).fill('Project command content.');
    await page.getByRole('checkbox', { name: 'Allow automatic selection by the agent' }).uncheck();
    await page.getByRole('button', { name: 'Save item', exact: true }).click();
    await expect(page.getByTestId('library-item-edit-local')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Commands', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await page.getByRole('radio', { name: 'Commands', exact: true }).click();
    await page.getByTestId('library-item-edit-local').getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByLabel('Item content', { exact: true })).toHaveValue('Project command content.');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('radio', { name: 'Skills', exact: true }).click();
    await page.getByTestId('library-item-edit-global').getByRole('button', { name: 'Customize', exact: true }).click();
    await page.getByLabel('Item content', { exact: true }).fill('Only this project sees this customization.');
    await page.getByRole('button', { name: 'Save item', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
    expect(readFileSync(join(global, 'SKILL.md'), 'utf8')).toContain('Original scoped text.');
    expect(readFileSync(join(local, 'SKILL.md'), 'utf8')).toContain('Project command content.');
    expect(JSON.parse(readFileSync(join(local, 'atelier.json'), 'utf8')).automatic).toBe(false);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(global, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider settings link to the single shared output-style selector', async ({ page }) => {
  test.skip(!!process.env.ATELIER_CAPTURE_BEFORE);
  await page.goto('/settings?section=claude');
  await expect(page.getByTestId('shared-output-style-link')).toBeVisible();
  await expect(page.getByText('Controls how Claude writes responses', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'tests/results/agent-files-delete/claude-style-after.png', fullPage: true });
  await page.getByRole('link', { name: 'Manage output styles' }).click();
  await expect(page.getByRole('radio', { name: 'Output styles', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Selected output style', { exact: true }).first()).toBeVisible();
});
