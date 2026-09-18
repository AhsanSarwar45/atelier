import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

/**
 * A chat that is still loading says so once. The manager's report, on a phone:
 * under "Loading conversation…" stood a second spinner reading "Starting 0s".
 * Nothing was starting — the page had not heard from the chat yet, and a chat
 * it has not heard from reads as the blank one, whose word is "Starting"
 * (bw-721t.1).
 *
 * The live connection is held open and never answered, so the page stays in
 * its loading state for as long as the check needs to look at it.
 */
const CHAT = 'b7210001-0000-4000-8000-000000000001';
const SHOTS = join(process.cwd(), 'tests', 'results');

function seed(project: { id: string; path: string }): void {
  const database = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  database.exec('PRAGMA busy_timeout = 5000');
  const at = '2026-09-19T09:00:00Z';
  try {
    database.exec('BEGIN IMMEDIATE');
    database
      .prepare(
        `INSERT INTO session
           (id, brand, project_id, project_path, cwd, permission_mode, title,
            state, origin, created_at, last_active_at, last_spoke_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(CHAT, 'claude', project.id, project.path, project.path, 'default', 'A chat to open', 'dormant', 'app', at, at, at);
    const insert = database.prepare('INSERT INTO event (session_id, seq, at, type, json) VALUES (?,?,?,?,?)');
    const told: Record<string, unknown>[] = [
      { type: 'message.started', messageId: 'said', role: 'assistant' },
      { type: 'text.delta', messageId: 'said', text: 'Here is what I found.' },
      { type: 'message.completed', messageId: 'said' },
    ];
    told.forEach((body, index) => {
      const seq = index + 1;
      insert.run(CHAT, seq, at, String(body.type), JSON.stringify({ ...body, sessionId: CHAT, seq, at }));
    });
    database.exec('COMMIT');
  } finally {
    database.close();
  }
}

test('a chat that is still loading shows the loading line and no working line', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-loading-chat');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  const made = await request.post('/api/projects', { data: { name: 'Loading chat', path: fixture } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };

  try {
    seed(project);
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${CHAT}"]`);
    await expect(row.getByTestId('row-name')).toBeVisible({ timeout: 60_000 });
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 120_000 });
    const address = page.url();

    // Every socket is accepted and never answered: the chat stays loading.
    await page.routeWebSocket(/.*/, () => {});
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(address);
    await expect(page.getByTestId('chat-loading')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);

    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'loading-chat-on-a-phone.png') });

    await expect(page.getByTestId('chat-loading')).toBeVisible();
    await expect(page.getByTestId('chat-tab').getByText('Starting', { exact: true })).toHaveCount(0);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
