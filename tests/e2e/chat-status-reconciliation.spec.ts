import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const run = process.env.WORKBENCH_E2E_RUN;
const baseline = process.env.CHAT_RECONCILE_BASELINE === '1';
const testUrl = process.env.BEADS_E2E_URL ? new URL(process.env.BEADS_E2E_URL) : null;
test.skip(!testUrl || !['localhost', '127.0.0.1'].includes(testUrl.hostname) || !testUrl.port || testUrl.port === '3008', 'requires an explicitly addressed disposable app, never the owner app');
test.skip(!run || !process.env.CLAUDE_ACP_TEST_SOURCE, 'requires the isolated actual-adapter fixture');

test('runtime reconciliation repairs missed status updates on open, send and a periodic sweep', async ({ page, request }) => {
  test.setTimeout(60_000);
  const projectPath = resolve(run!, `reconcile-project-${Date.now()}`);
  mkdirSync(resolve(projectPath, '.beads'), { recursive: true });
  writeFileSync(resolve(projectPath, '.beads/metadata.json'), JSON.stringify({ database: 'fixture.db', backend: 'sqlite' }));
  writeFileSync(resolve(projectPath, '.beads/issues.jsonl'), '');
  const made = await request.post('/api/projects', { data: { name: 'Runtime status reconciliation', path: projectPath } });
  expect(made.ok(), await made.text()).toBe(true);
  const project = await made.json();
  const command = async (data: Record<string, unknown>) => {
    const response = await request.post('/api/workbench/command', { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const session = await command({ type: 'session.start', brand: 'claude', projectId: project.id, projectPath, title: 'Completed chat with stale status' });
  const db = new DatabaseSync(resolve(run!, 'xdg/atelier/workbench.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const state = () => (db.prepare('SELECT state FROM session WHERE id=?').get(session.id) as { state: string }).state;
  const stale = (value: string) => {
    // Simulate a missed/late status write, including the stored projection.
    // Deliberately bypass the event bus: only a real read or periodic runtime
    // reconciliation can repair this; another provider event cannot mask it.
    db.exec('BEGIN IMMEDIATE');
    const seq = Number((db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM event WHERE session_id=?').get(session.id) as { seq: number }).seq);
    const at = new Date().toISOString();
    db.prepare('UPDATE session SET state=? WHERE id=?').run(value, session.id);
    db.prepare('INSERT INTO event (session_id,seq,at,type,json) VALUES (?,?,?,?,?)').run(session.id, seq, at, 'session.state', JSON.stringify({ type: 'session.state', sessionId: session.id, seq, at, state: value, label: value === 'streaming' ? 'Answering' : 'Idle' }));
    db.exec('COMMIT');
  };
  const send = (text: string) => command({ type: 'prompt.send', sessionId: session.id, text });
  await send('complete immediately');
  await expect.poll(state).toBe('idle');
  stale('streaming');
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${session.id}`);
  const row = page.locator(`[data-testid="restore-row"][data-row-key="${session.id}"]`);
  await expect(row).toHaveAttribute('data-state', baseline ? 'streaming' : 'idle');
  await expect(page.getByTestId('chat-tab')).toContainText('The new turn completed.');
  await page.screenshot({ path: `tests/results/bw-b0m4-reconcile-${baseline ? 'before' : 'after'}.png` });
  if (baseline) { db.close(); return; }
  await expect(page.getByTestId('stop-button')).toHaveCount(0);
  await expect(row.getByTestId('chat-state-count')).toHaveCount(0);
  // No open, prompt, or provider event repairs this write: the periodic sweep must.
  stale('streaming');
  await expect.poll(state, { timeout: 12_000 }).toBe('idle');
  // Sending must inspect runtime facts rather than steering a nonexistent turn.
  stale('streaming');
  await send('complete immediately');
  await expect.poll(state).toBe('idle');
  // Reconciliation must also repair false Idle without cancelling genuine work.
  await send('Start a helper and hold the turn.');
  await expect.poll(state).toBe('waiting_for_agents');
  stale('idle');
  await page.reload();
  await expect(row).toHaveAttribute('data-state', 'waiting_for_agents');
  await expect(page.getByTestId('stop-button')).toBeVisible();
  await page.getByTestId('stop-button').click();
  await expect(row).toHaveAttribute('data-state', 'stopped');
  await page.reload();
  await expect(row).toHaveAttribute('data-state', 'stopped');
  db.close();
});
