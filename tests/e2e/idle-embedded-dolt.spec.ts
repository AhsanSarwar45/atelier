import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const run = process.env.WORKBENCH_E2E_RUN ?? join(process.cwd(), 'tests', '.e2e-run-bw-hou2');
const fixture = join(run, 'idle-embedded-dolt');
const serverLog = join(run, 'server.log');

function bd(...args: string[]) {
  return execFileSync('bd', args, { cwd: fixture, encoding: 'utf8' });
}

function occurrences(needle: string): number {
  return readFileSync(serverLog, 'utf8').split(needle).length - 1;
}

test('an idle embedded-Dolt board stays quiet and a real write still reaches it', async ({ page, request }) => {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  execFileSync('git', ['init', '--quiet', fixture]);
  bd('init', '--prefix', 'quiet', '--non-interactive', '--skip-agents', '--skip-hooks');
  bd('create', '--title', 'The card already here', '--type', 'task', '--priority', '2');
  mkdirSync(join(fixture, '.atelier'), { recursive: true });
  writeFileSync(
    join(fixture, '.atelier', 'project.toml'),
    'schema_version = 1\n\n[project]\ndisplay_name = "Quiet embedded Dolt"\nuse_beads = true\nsummary = ""\n\n[git]\ncompleted_work_branch = "master"\n\n[beads]\nissue_id_prefix = "quiet"\n',
  );

  const made = await request.post('/api/projects', {
    data: { name: 'Quiet embedded Dolt', path: fixture },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  try {
    await page.goto(`/project?id=${project.id}&tab=board`);
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('The card already here')).toBeVisible({ timeout: 30_000 });

    // Let the first legitimate read and the watcher's debounce finish, then
    // prove that neither restarts itself while the project is idle.
    await page.waitForTimeout(500);
    const reads = occurrences(`beads from bd CLI for ${fixture}`);
    const changes = occurrences(`Board change detected: "${fixture}/.beads/embeddeddolt"`);
    await page.waitForTimeout(1_500);
    expect(occurrences(`beads from bd CLI for ${fixture}`)).toBe(reads);
    expect(occurrences(`Board change detected: "${fixture}/.beads/embeddeddolt"`)).toBe(changes);

    // A persisted row change still moves the same files. It must cross the
    // watcher rather than waiting for the client's 15-second backstop poll.
    bd('create', '--title', 'The real write arrived', '--type', 'task', '--priority', '2');
    await expect(page.getByText('The real write arrived')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: join(process.cwd(), 'tests', 'results', 'bw-hou2-idle-embedded-dolt.png'),
      fullPage: true,
    });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});
