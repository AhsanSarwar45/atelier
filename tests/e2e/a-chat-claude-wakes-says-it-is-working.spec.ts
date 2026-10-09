import { expect, test } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A chat Claude wakes by itself says it is working (bw-hlu1o).
 *
 * A background command ends, the CLI wakes the agent, and the agent runs a turn
 * of its own. No prompt of ours stands behind that turn, so the app counted
 * nothing: a chat ran thirty-seven commands under Ready. The adapter now passes
 * on the CLI's own `running` and `idle`, and the turn is counted between them.
 *
 * Runs the real pinned adapter over the fake Query in
 * `tests/fixtures/claude-background-query.mjs` (docs/chat-status.md).
 * `CLAUDE_WAKE_BASELINE=1` with the unpatched adapter expects the old reading.
 */
const run = process.env.WORKBENCH_E2E_RUN;
const baseline = process.env.CLAUDE_WAKE_BASELINE === '1';
const testUrl = process.env.BEADS_E2E_URL ? new URL(process.env.BEADS_E2E_URL) : null;
test.skip(!testUrl || !['localhost', '127.0.0.1'].includes(testUrl.hostname) || !testUrl.port || testUrl.port === '3008', 'requires an explicitly addressed disposable app, never the owner app');
test.skip(!run || !process.env.CLAUDE_ACP_TEST_SOURCE, 'requires the compiled pinned adapter and isolated fake Query');

test('a turn Claude starts by itself reads as working until it ends', async ({ page, request }) => {
  test.setTimeout(90_000);
  const stage = baseline ? 'before' : 'after';
  const projectPath = resolve(run!, `wake-project-${stage}`);
  rmSync(projectPath, { recursive: true, force: true });
  mkdirSync(resolve(projectPath, '.beads'), { recursive: true });
  writeFileSync(resolve(projectPath, '.beads/metadata.json'), JSON.stringify({ database: 'fixture.db', backend: 'sqlite' }));
  writeFileSync(resolve(projectPath, '.beads/issues.jsonl'), '');
  const made = await request.post('/api/projects', { data: { name: 'Claude wakes by itself', path: projectPath } });
  expect(made.ok(), await made.text()).toBe(true);
  const project = await made.json();
  const command = async (data: Record<string, unknown>) => {
    const response = await request.post('/api/workbench/command', { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  try {
    const session = await command({ type: 'session.start', brand: 'claude', projectId: project.id, projectPath, title: 'Woken by its own command' });
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${session.id}"]`);
    await command({ type: 'prompt.send', sessionId: session.id, text: 'Run a command in the background, then wake by itself when it ends.' });
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${session.id}`);
    await expect(page.getByTestId('chat-tab')).toContainText('Started the command in the background.');
    await expect(row).toHaveAttribute('data-state', 'idle');

    writeFileSync(resolve(projectPath, 'wake-1'), 'done');
    await expect(page.getByTestId('chat-tab')).toContainText('The command finished, so I am checking its output.');
    if (baseline) {
      // The old reading: the agent is answering and the chat says Idle.
      await expect(row).toHaveAttribute('data-state', 'idle');
      await expect(row).toContainText('Idle');
      await expect(page.getByTestId('stop-button')).toHaveCount(0);
    } else {
      await expect(row).toHaveAttribute('data-state', 'streaming');
      await expect(row).toContainText('Answering');
      await expect(page.getByTestId('stop-button')).toBeVisible();
      // The decision is made on the server, so a reload reads the same.
      await page.reload();
      await expect(row).toHaveAttribute('data-state', 'streaming');
    }
    await page.screenshot({ path: `tests/results/bw-hlu1o-woken-${stage}.png` });

    writeFileSync(resolve(projectPath, 'end-wake-1'), 'done');
    await expect(page.getByTestId('chat-tab')).toContainText('Its output is fine.');
    await expect(row).toHaveAttribute('data-state', 'idle');
    await expect(page.getByTestId('stop-button')).toHaveCount(0);
    if (baseline) return;

    // The next message is an ordinary prompt and finishes as one.
    await command({ type: 'prompt.send', sessionId: session.id, text: 'complete immediately' });
    await expect(page.getByTestId('chat-tab')).toContainText('The new turn completed.');
    await expect(row).toHaveAttribute('data-state', 'idle');
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(projectPath, { recursive: true, force: true });
  }
});
