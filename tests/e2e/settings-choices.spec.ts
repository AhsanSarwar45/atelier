import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * Settings that have a known set of answers are dropdowns: language, output
 * style (including the account's own style files), and a project's branches,
 * which can also name a branch the repo does not have yet. The install guide
 * link in Dependencies is readable (bw-nin9.4, bw-nin9.5).
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

test('a project\'s branches are chosen from the repo, or named new', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // Branches are read through the git API, which only looks inside the home directory.
  mkdirSync(join(process.cwd(), 'tests', '.artifacts'), { recursive: true });
  const repo = mkdtempSync(join(process.cwd(), 'tests', '.artifacts', 'settings-choices-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'initial']);
  for (const branch of ['release', 'hotfix']) execFileSync('git', ['-C', repo, 'branch', branch]);
  // A project with a policy file, tracking its work, the way onboarding leaves one.
  const probe = (await (await request.post('/api/projects/probe', { data: { path: repo } })).json()) as { manifest: { project: { use_beads: boolean } } };
  probe.manifest.project.use_beads = true;
  const made = await request.post('/api/projects/initialize', { data: { path: repo, storage: 'repository', manifest: probe.manifest } });
  expect(made.status(), await made.text()).toBe(201);
  const id = ((await (await request.get('/api/projects')).json()) as { id: string; path: string }[]).find((row) => row.path === repo)!.id;
  try {
    await page.goto(`/project?id=${id}&settings=workflow`);
    await page.getByTestId('settings-branch').click();
    await expect(page.getByRole('option', { name: 'release' })).toBeVisible();
    await page.getByRole('option', { name: 'New branch…' }).click();
    await page.getByTestId('settings-branch-new').fill('landing');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('settings-branch')).toContainText('landing');

    // release was inferred as protected when the policy was made; hotfix is chosen here.
    await expect(page.getByTestId('settings-protected-release')).toBeVisible();
    await page.getByTestId('settings-protected-add').click();
    await page.getByRole('option', { name: 'hotfix' }).click();
    await expect(page.getByTestId('settings-protected-hotfix')).toBeVisible();
    await page.screenshot({ path: join(results, 'desktop-branches.png') });

    await page.getByTestId('project-settings-save').click();
    await expect(page.getByTestId('project-settings-save')).toHaveCount(0);
    const saved = (await (await request.get(`/api/projects/${id}/settings`)).json()) as { manifest: { git: { completed_work_branch: string; protected_branches: string[] } } };
    expect(saved.manifest.git.completed_work_branch).toBe('landing');
    expect(saved.manifest.git.protected_branches).toEqual(expect.arrayContaining(['release', 'hotfix']));
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', 'landing'], { encoding: 'utf8' })).toContain('landing');
  } finally {
    await request.delete(`/api/projects/${id}`);
    rmSync(repo, { recursive: true, force: true });
  }
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
