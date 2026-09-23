import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// An opt-in, bounded disposable instance for Chrome DevTools MCP exploration.
// The ordinary harness owns every process, credential copy and cleanup.
test('shared-library Chrome DevTools laboratory', async ({ request }) => {
  test.skip(process.env.BEADS_LIBRARY_LAB !== '1', 'manual MCP exploration only');
  test.setTimeout(60 * 60_000);
  const run = process.env.WORKBENCH_E2E_RUN!;
  expect(run).toBeTruthy();
  mkdirSync(join(run, 'projects'), { recursive: true });
  const projects: { id: string; path: string; name: string }[] = [];
  try {
    for (const name of ['Library Alpha', 'Library Beta']) {
      const path = mkdtempSync(join(run, 'projects', 'guidance-'));
      execFileSync('git', ['init', '-q', '-b', 'main', path]);
      writeFileSync(join(path, 'package.json'), JSON.stringify({ dependencies: name.endsWith('Alpha') ? { next: '16.0.0' } : {} }));
      const made = await request.post('/api/projects', { data: { name, path } });
      expect(made.status(), await made.text()).toBe(201);
      const project = await made.json(); projects.push({ ...project, name });
      expect((await request.get(`/api/projects/${project.id}/settings`)).ok()).toBeTruthy();
    }
    writeFileSync(join(run, 'lab.json'), JSON.stringify({ projects, url: process.env.BEADS_E2E_URL }));
    console.log('Chrome DevTools laboratory ready', JSON.stringify(projects));
    await expect.poll(() => existsSync(join(run, 'lab-complete')), { timeout: 55 * 60_000, intervals: [1000] }).toBe(true);
  } finally {
    for (const project of projects) await request.delete(`/api/projects/${project.id}`);
  }
});
