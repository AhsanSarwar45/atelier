import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// bw-1fw6: a reply that is over while the command it sent to the background
// runs on, with the adapter holding the prompt open and no notice of the
// command's end ever sent. Run only against the disposable stack with
// fixture-held-background.py as its Claude adapter. No browser mocks.
const run = process.env.WORKBENCH_E2E_RUN;
const baseline = process.env.CHAT_BACKGROUND_BASELINE === '1';
const testUrl = process.env.BEADS_E2E_URL ? new URL(process.env.BEADS_E2E_URL) : null;
test.skip(!testUrl || !['localhost', '127.0.0.1'].includes(testUrl.hostname) || !testUrl.port || testUrl.port === '3008', 'requires an explicitly addressed disposable app, never the owner app');
test.skip(!run || process.env.CHAT_HELD_BACKGROUND_FIXTURE !== '1', 'requires the isolated held-background fixture');

test('a finished reply reads Background working while its command runs, then Ready with nothing left running', async ({ page, request }) => {
  test.setTimeout(90_000);
  const projectPath = resolve(run!, `background-settles-${Date.now()}`);
  mkdirSync(resolve(projectPath, '.beads'), { recursive: true });
  writeFileSync(resolve(projectPath, '.beads/metadata.json'), JSON.stringify({ database: 'fixture.db', backend: 'sqlite' }));
  writeFileSync(resolve(projectPath, '.beads/issues.jsonl'), '');
  const made = await request.post('/api/projects', { data: { name: 'Background settles', path: projectPath } });
  expect(made.ok(), await made.text()).toBe(true);
  const project = await made.json();
  const command = async (data: Record<string, unknown>) => {
    const response = await request.post('/api/workbench/command', { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const session = await command({ type: 'session.start', brand: 'claude', projectId: project.id, projectPath, title: 'Chat search planning' });
  await command({ type: 'prompt.send', sessionId: session.id, text: 'Run the check in the background and finish your reply.' });
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${session.id}`);
  const row = page.locator(`[data-testid="restore-row"][data-row-key="${session.id}"]`);
  const shell = page.getByTestId('sent-away-row').first();
  await expect(page.getByTestId('chat-tab')).toContainText('The reply is complete', { timeout: 30_000 });
  await expect(shell).toHaveAttribute('data-state', 'running');

  if (!baseline) {
    // The reply is over and its command is not.
    await expect(row).toHaveAttribute('data-state', 'waiting_for_agents', { timeout: 15_000 });
    await expect(row).toContainText('Background working');
    await page.screenshot({ path: 'tests/results/bw-1fw6-background-working.png' });
  }

  // The command ends. Nothing tells the app.
  writeFileSync(resolve(projectPath, 'finish-bg-1'), 'done');
  if (baseline) {
    await page.waitForTimeout(15_000);
    await page.screenshot({ path: 'tests/results/bw-1fw6-before.png' });
    await expect(row).not.toHaveAttribute('data-state', 'idle');
    await expect(shell).toHaveAttribute('data-state', 'running');
    return;
  }
  await expect(row).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  await expect(shell).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('stop-button')).toHaveCount(0);
  // The same wait the baseline is given before its picture.
  await page.waitForTimeout(15_000);
  await page.screenshot({ path: 'tests/results/bw-1fw6-after.png' });

  // A reload reads the same.
  await page.reload();
  await expect(row).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('sent-away-row').first()).toHaveAttribute('data-state', 'done');

  // A message sent while the adapter still holds the prompt goes into that
  // turn, and its reply settles the same way.
  await command({ type: 'prompt.send', sessionId: session.id, text: 'Run it again.' });
  await expect(row).toHaveAttribute('data-state', 'waiting_for_agents', { timeout: 15_000 });
  await expect(page.getByTestId('sent-away-row').first()).toHaveAttribute('data-state', 'running');
  writeFileSync(resolve(projectPath, 'finish-bg-2'), 'done');
  await expect(row).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  await expect(page.getByTestId('stop-button')).toHaveCount(0);
});
