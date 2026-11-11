import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { test as base, expect, chromium } from '@playwright/test';

const test = base.extend({ browser: [async ({}, use) => {
  const browser = await chromium.connectOverCDP(process.env.CDP_URL!);
  await use(browser);
}, { scope: 'worker' }] });
const run = process.env.WORKBENCH_E2E_RUN;
const baseline = process.env.CHAT_CHILD_IDLE_BASELINE === '1';
test.skip(!run || !process.env.CDP_URL || process.env.CHAT_LIFECYCLE_FIXTURE !== '1', 'requires isolated lifecycle fixture and Atelier Chrome');
test.describe.configure({ mode: 'serial', timeout: 60_000 });

for (const brand of ['codex', 'claude']) {
  test(`${brand}: child completion cannot end the parent turn`, async ({ page, request }, info) => {
    const projectPath = resolve(run!, `child-idle-${brand}`);
    execFileSync('git', ['init', '--quiet', projectPath]);
    mkdirSync(resolve(projectPath, '.atelier'), { recursive: true });
    writeFileSync(resolve(projectPath, '.atelier/project.toml'), `schema_version = 1\n[project]\ndisplay_name = "Child completion ${brand}"\n[git]\ncompleted_work_branch = "main"\n`);
    const created = await request.post('/api/projects', { data: { name: `Child completion ${brand}`, path: projectPath } });
    expect(created.ok(), await created.text()).toBe(true);
    const project = await created.json();
    const command = async (data: Record<string, unknown>) => {
      const response = await request.post('/api/workbench/command', { data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    let sessionId: string | undefined;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('response', response => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    try {
      const session = await command({ type: 'session.start', brand, projectId: project.id, projectPath, title: 'Parent keeps working' });
      sessionId = session.id;
      await command({ type: 'prompt.send', sessionId, text: 'child-idle while the parent keeps working' });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      const row = page.locator(`[data-testid="restore-row"][data-row-key="${sessionId}"]`);
      await expect(page.getByTestId('chat-tab')).toBeVisible();
      await expect(row).toHaveAttribute('data-state', 'running_tool');
      writeFileSync(resolve(projectPath, 'finish-child'), '');
      await expect(page.getByTestId('chat-tab')).toContainText(/Waiting\s*60s/);
      await expect(row).toHaveAttribute('data-state', baseline ? 'idle' : 'running_tool');
      // Cross the periodic reconciliation sweep, then reopen the same session.
      await page.waitForTimeout(5500);
      await expect(row).toHaveAttribute('data-state', baseline ? 'idle' : 'running_tool');
      await page.screenshot({ path: info.outputPath(`${brand}-${baseline ? 'before' : 'after'}.png`) });
      await page.reload();
      await expect(row).toHaveAttribute('data-state', baseline ? 'idle' : 'running_tool');
      if (!baseline) {
        await expect(row).toContainText('Parent keeps working');
        await expect(page.getByTestId('stop-button')).toBeVisible();
      }
      writeFileSync(resolve(projectPath, 'finish-parent'), '');
      await expect(page.getByTestId('chat-tab')).toContainText('The parent turn completed.');
      await expect(row).toHaveAttribute('data-state', 'idle');
      await expect(page.getByTestId('stop-button')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      if (sessionId) await command({ type: 'session.stop', sessionId });
      expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBe(true);
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
}
