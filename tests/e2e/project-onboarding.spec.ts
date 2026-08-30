import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

test('a new project reviews inferred settings and can edit the saved policy', async ({ page, request }) => {
  const repo = mkdtempSync(join(tmpdir(), 'atelier-project-onboarding-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Atelier Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'atelier@example.test']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'initial']);
  let project: { id: string } | null = null;

  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add Project' }).click();
    await page.getByLabel('Project Path').fill(repo);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByLabel('Project Name')).toBeVisible();
    await page.getByLabel('Project Name').fill('Onboarding Proof');
    await expect(page.getByLabel('Use task tracking for project work')).not.toBeChecked();
    await page.getByRole('combobox', { name: 'Store project settings' }).click();
    await page.getByRole('option', { name: 'In .atelier/project.toml' }).click();
    const initialized = page.waitForResponse((response) => response.url().endsWith('/api/projects/initialize'));
    await page.getByRole('button', { name: 'Add Project' }).click();
    const response = await initialized;
    expect(response.status(), await response.text()).toBe(201);

    await expect(page.getByRole('link', { name: 'View Onboarding Proof project' })).toBeVisible();
    expect(existsSync(join(repo, '.atelier/project.toml'))).toBe(true);
    project = ((await (await request.get('/api/projects')).json()) as { id: string; name: string }[])
      .find((row) => row.name === 'Onboarding Proof') ?? null;
    expect(project).not.toBeNull();

    await page.getByRole('button', { name: 'Project settings' }).click();
    await expect(page.getByRole('heading', { name: 'Project Settings' })).toBeVisible();
    await page.getByLabel('Project summary').fill('The settings screen owns this project policy.');
    await page.getByRole('combobox', { name: 'External review' }).click();
    await page.getByRole('option', { name: 'Never' }).click();
    await page.screenshot({ path: join(process.cwd(), 'tests/results/project-settings.png'), fullPage: true });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: 'Project Settings' })).toBeHidden();

    const saved = await (await request.get(`/api/projects/${project!.id}/settings`)).json();
    expect(saved.manifest.project.summary).toBe('The settings screen owns this project policy.');
    expect(saved.manifest.review.external_review).toBe('never');
    expect(saved.storage).toBe('repository');
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(repo, { recursive: true, force: true });
  }
});
