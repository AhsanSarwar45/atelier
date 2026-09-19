import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtureProject, bd, discardFixture } from './fixture-board';

test('landed and nested work agree across the board and detail', async ({ page, request }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 2200, height: 1000 });
  const run = join(process.cwd(), 'tests/.e2e-run-bw-9vv9/fixture');
  const path = makeFixtureProject(join(run, 'project'), join(run, 'reports'));
  bd(['update', 'wl-demo1', '--title', 'Partially landed job', '--status', 'in_progress'], path);
  bd(['create', '--id', 'wl-done', '--title', 'Fully landed job', '--type', 'epic'], path);
  bd(['create', '--id', 'wl-done.1', '--title', 'Landed implementation'], path);
  bd(['update', 'wl-done.1', '--parent', 'wl-done'], path);
  bd(['close', 'wl-done.1', '--reason', 'Fixture landed work'], path);
  bd(['create', '--id', 'wl-nested', '--title', 'Nested active job', '--type', 'epic'], path);
  bd(['create', '--id', 'wl-nested.1', '--title', 'Nested phase', '--type', 'epic'], path);
  bd(['create', '--id', 'wl-nested.1.1', '--title', 'Active implementation'], path);
  bd(['update', 'wl-nested.1', '--parent', 'wl-nested'], path);
  bd(['update', 'wl-nested.1.1', '--parent', 'wl-nested.1'], path);
  bd(['update', 'wl-nested.1.1', '--status', 'in_progress'], path);
  const made = await request.post('/api/projects', { data: { name: 'Landing lifecycle proof', path } });
  expect(made.status(), await made.text()).toBe(201);
  const project = await made.json();
  const url = `/project?id=${project.id}&tab=board`;
  const phase = process.env.LIFECYCLE_PHASE ?? 'after';
  const output = join(process.cwd(), 'tests/results/landing-state');
  mkdirSync(output, { recursive: true });
  try {
    await page.goto(url);
    await expect(page.getByText('Partially landed job', { exact: true }).first()).toBeVisible({timeout: 60_000});
    if (phase === 'after') {
      const beads = await request.get(`/api/beads?path=${encodeURIComponent(path)}`);
      const data = await beads.json();
      writeFileSync(join(output, 'api.json'), JSON.stringify(data, null, 2));
    }
    const captureEnv = { ...process.env };
    delete captureEnv.ATELIER_PRESENTATION_MEDIA_DIR;
    delete captureEnv.ATELIER_PRESENTATION_EPHEMERAL;
    const shot = join(output, `${phase}.png`);
    await page.screenshot({ path: shot, animations: 'disabled' });
    const capture = execFileSync('atelier', ['tool', 'screen-check', 'capture', '--type', 'image', '--target', shot], { env: captureEnv, encoding: 'utf8', timeout: 120_000 });
    writeFileSync(join(output, `${phase}.json`), capture);
    console.log(capture);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
