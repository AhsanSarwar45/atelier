import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Run only against the disposable stack with fixture-chat-lifecycle.py as its
// ACP adapter. This exercises real transport/storage/streams; no browser mocks.
const run = process.env.WORKBENCH_E2E_RUN;
test.skip(!run || process.env.CHAT_LIFECYCLE_FIXTURE !== '1', 'requires the isolated lifecycle fixture');
test.describe.configure({ mode: 'serial', timeout: 60_000 });

for (const brand of ['codex', 'claude']) {
  test(`${brand}: Stop settles a silent provider, survives reload, and resumes immediately`, async ({ page, request }) => {
    const projectPath = resolve(run!, `project-${brand}`);
    mkdirSync(resolve(projectPath, '.beads'), { recursive: true });
    writeFileSync(resolve(projectPath, '.beads/metadata.json'), JSON.stringify({ database: 'fixture.db', backend: 'sqlite' }));
    writeFileSync(resolve(projectPath, '.beads/issues.jsonl'), '');
    const existing = await (await request.get('/api/projects')).json();
    for (const project of existing.filter((p: { path: string }) => p.path === projectPath)) {
      await request.delete(`/api/projects/${project.id}`);
    }
    const created = await request.post('/api/projects', { data: { name: `Stop regression ${brand}`, path: projectPath } });
    expect(created.ok(), await created.text()).toBe(true);
    const project = await created.json();
    const command = async (data: Record<string, unknown>) => {
      const response = await request.post('/api/workbench/command', { data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const session = await command({ type: 'session.start', brand, projectId: project.id, projectPath, title: 'Skip tests during release' });
    const send = (text: string) => command({ type: 'prompt.send', sessionId: session.id, text });
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${session.id}"]`);
    await send('Run the claim command, then wait.');
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${session.id}`);
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('Claiming bw-105s.1');
    const providerPid = Number(readFileSync(resolve(projectPath, 'lifecycle-pids'), 'utf8').trim().split('\n').at(-1));
    const response = page.waitForResponse(r => r.url().endsWith('/api/workbench/command') && r.request().postDataJSON()?.type === 'session.stop');
    await page.getByTestId('stop-button').click();
    expect(await (await response).json()).toMatchObject({ ok: true, detached: true });
    await expect(row).toContainText('Stopped');
    await expect(row.getByTestId('chat-state-count')).toHaveCount(0);
    await expect(page.getByTestId('stop-button')).toHaveCount(0);
    await expect.poll(() => { try { process.kill(providerPid, 0); return false; } catch { return true; } }).toBe(true);
    await page.reload();
    await expect(row).toContainText('Stopped');
    await expect(row).not.toContainText('Claiming');
    await command({ type: 'session.stop', sessionId: session.id }); // idempotent without a driver
    await send('Please complete the next turn.');
    await expect(page.getByTestId('chat-tab')).toContainText('The new turn completed.');
    await expect(row).toContainText('Idle');
    await page.waitForTimeout(400); // deliberately late active metadata must not revive the turn
    await expect(row).toContainText('Idle');
    await expect(row.getByTestId('chat-state-count')).toHaveCount(0);
    await send('Run the claim command again, then wait.');
    await expect(page.getByTestId('stop-button')).toBeVisible();
    await page.getByTestId('stop-button').click();
    await expect(row).toContainText('Stopped');
    await page.reload();
    await expect(row).toContainText('Stopped');
    if (brand === 'codex') {
      await send('native-idle without a prompt response');
      await expect(row).toHaveAttribute('data-state', 'idle');
      await expect(page.getByTestId('stop-button')).toHaveCount(0);
      await send('Run another command and remain active.');
      await page.waitForTimeout(400); // the old RPC responds during this turn
      await expect(row).toHaveAttribute('data-state', 'running_tool');
      await page.getByTestId('stop-button').click();
      await expect(row).toContainText('Stopped');
    }
    await send('crash the fixture transport');
    await expect(row).toHaveAttribute('data-state', 'errored');
    await expect(row).not.toContainText('Claiming');
    await expect(page.getByTestId('stop-button')).toHaveCount(0);
    await page.reload();
    await expect(row).toHaveAttribute('data-state', 'errored');
    await request.delete(`/api/projects/${project.id}`);
  });
}
