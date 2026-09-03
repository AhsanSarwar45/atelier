import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const THREAD = '01a1a777-0e7b-7a02-b871-d58e399effd1';
const TURN = '01a1a777-4b23-76b2-b68f-0f274341a124';
const PROMPT = 'Inspect the external status path.';

function installActiveRollout(projectPath: string): void {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) throw new Error('CODEX_HOME must name the isolated E2E Codex home');
  const directory = join(codexHome, 'sessions', '2026', '09', '02');
  mkdirSync(directory, { recursive: true });
  const rows = [
    {
      timestamp: '2026-09-02T06:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: THREAD,
        timestamp: '2026-09-02T06:00:00.000Z',
        cwd: projectPath,
        originator: 'codex-tui',
        cli_version: '0.152.0',
        source: 'cli',
        model_provider: 'openai',
      },
    },
    {
      timestamp: '2026-09-02T06:00:00.500Z',
      type: 'turn_context',
      payload: { cwd: projectPath, approval_policy: 'on-request', model: 'gpt-5.4', reasoning_effort: 'high' },
    },
    {
      timestamp: '2026-09-02T06:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: TURN, model_context_window: 258_400 },
    },
    {
      timestamp: '2026-09-02T06:00:01.100Z',
      type: 'event_msg',
      payload: { type: 'user_message', id: 'person-1', message: PROMPT, images: [], local_images: [] },
    },
    {
      timestamp: '2026-09-02T06:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'item_started',
        item: {
          type: 'CommandExecution',
          commandActions: [{ type: 'read', path: 'server/src/workbench/external.rs' }],
        },
      },
    },
  ];
  writeFileSync(
    join(directory, `rollout-2026-09-02T11-00-00-${THREAD}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

function startCodexProcess(): ChildProcess {
  const run = process.env.WORKBENCH_E2E_RUN!;
  const executable = join(run, 'fixture-bin', 'codex');
  mkdirSync(join(run, 'fixture-bin'), { recursive: true });
  copyFileSync('/bin/bash', executable);
  chmodSync(executable, 0o700);
  // Stay in this executable using shell builtins. The UUID is an argv value,
  // exactly as it is for `codex resume <thread>`, so the Rust detector reads a
  // real isolated process table entry without starting a provider or touching
  // any user process.
  return spawn(executable, ['-c', 'while true; do read -t 1 || true; done', THREAD], { stdio: 'ignore' });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 2_000);
  });
}

test('a live external Codex chat has rich sidebar activity and no transcript-header status', async ({ page, request }) => {
  test.setTimeout(90_000);
  const run = process.env.WORKBENCH_E2E_RUN!;
  const projectPath = join(run, 'codex-external-project');
  rmSync(projectPath, { recursive: true, force: true });
  mkdirSync(projectPath, { recursive: true });
  installActiveRollout(projectPath);
  const child = startCodexProcess();
  let project: { id: string } | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const made = await request.post('/api/projects', {
      data: { name: 'Codex external status fixture', path: projectPath, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();

    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    await page.goto(`/project?id=${project!.id}&tab=chat`);

    const row = page.locator(`[data-testid="restore-row"][data-external-id="${THREAD}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveAttribute('data-running', 'yes');
    await expect(row.getByTestId('external-origin')).toBeVisible();
    await expect(row.getByTestId('row-pill')).toContainText('Running');
    await expect(row.getByTestId('row-pill')).toContainText('Reading server/src/workbench/external.rs');

    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('user-message').filter({ hasText: PROMPT })).toHaveCount(1);
    await expect(page.getByTestId('held-elsewhere')).toBeVisible();
    await expect(page.getByTestId('session-state'), 'status regressed into the transcript header').toHaveCount(0);

    await stop(child);
    await expect(row).toHaveAttribute('data-running', 'no', { timeout: 30_000 });
    await expect(row.getByTestId('external-origin')).toHaveCount(0);
    await expect(page.getByTestId('held-elsewhere')).toHaveCount(0);
    await expect(page.getByTestId('composer')).toBeEnabled();
  } finally {
    await stop(child);
    if (project) await request.delete(`/api/projects/${project.id}`).catch(() => {});
    rmSync(projectPath, { recursive: true, force: true });
  }
});
