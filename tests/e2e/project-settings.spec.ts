import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * A project's settings are the same sectioned screen as Settings, drawn over
 * the project with the section in the address. Its Claude Code and Codex
 * sections write the project's own files (bw-2t1c.10).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/project-settings.spec.ts
 */

const results = 'tests/results/project-settings';

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

async function project(request: Parameters<Parameters<typeof test>[1]>[0]['request'], name: string) {
  const repo = mkdtempSync(join(tmpdir(), 'atelier-project-settings-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const made = await request.post('/api/projects', { data: { name, path: repo } });
  expect(made.status(), await made.text()).toBe(201);
  const { id } = (await made.json()) as { id: string };
  return { id, repo };
}

test('a section opens from the project bar and a provider setting lands in the project file', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { id, repo } = await project(request, 'Sectioned');
  try {
    await page.goto(`/project?id=${id}`);
    await page.getByRole('button', { name: 'Project settings' }).click();
    await expect(page).toHaveURL(/settings=project/);
    await expect(page.getByTestId('project-general')).toBeVisible();

    await page.getByTestId('settings-section-claude').click();
    await expect(page).toHaveURL(/settings=claude/);
    await expect(page.getByTestId('provider-settings-claude-defaults')).toBeVisible();
    await page.locator('#setting-claude-effortLevel').click();
    await page.getByRole('option', { name: /^Low/ }).click();
    await expect.poll(() => existsSync(join(repo, '.claude', 'settings.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).effortLevel).toBe('low');

    // The other file: the one only this computer reads.
    await page.getByTestId('claude-layer').click();
    await page.getByRole('option', { name: /Only me/ }).click();
    await page.getByTestId('provider-tab-permissions').click();
    await expect(page).toHaveURL(/ptab=permissions/);
    await page.locator('#setting-claude-permissions-defaultMode').click();
    await page.getByRole('option', { name: /^Plan/ }).click();
    await expect.poll(() => existsSync(join(repo, '.claude', 'settings.local.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8')).permissions.defaultMode).toBe('plan');
    await page.screenshot({ path: join(results, 'desktop-claude.png') });

    await page.getByTestId('settings-section-codex').click();
    await expect(page.getByTestId('provider-settings-codex-defaults')).toBeVisible();
    await page.locator('#setting-codex-model_reasoning_effort').click();
    await page.getByRole('option', { name: /^Low/ }).click();
    await expect.poll(() => existsSync(join(repo, '.codex', 'config.toml'))).toBe(true);
    expect(readFileSync(join(repo, '.codex', 'config.toml'), 'utf8')).toMatch(/model_reasoning_effort = "low"/);

    // Back steps out of the settings, section by section, then off them.
    await page.goBack();
    await expect(page).toHaveURL(/settings=claude/);
    await page.getByTestId('project-settings').getByTestId('back-arrow').click();
    await expect(page).not.toHaveURL(/settings=/);
    await expect(page.getByTestId('project-settings')).toHaveCount(0);
  } finally {
    await request.delete(`/api/projects/${id}`);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a phone gets the list, then one section', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { id, repo } = await project(request, 'Pocket');
  try {
    await page.goto(`/project?id=${id}&settings=list`);
    await expect(page.getByTestId('settings-nav')).toBeVisible();
    await expect(page.getByTestId('settings-body')).toBeHidden();
    await page.screenshot({ path: join(results, 'phone-list.png') });
    await page.getByTestId('settings-section-development').click();
    await expect(page.getByTestId('settings-nav')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Development' })).toBeVisible();
    await page.screenshot({ path: join(results, 'phone-section.png') });
  } finally {
    await request.delete(`/api/projects/${id}`);
    rmSync(repo, { recursive: true, force: true });
  }
});
