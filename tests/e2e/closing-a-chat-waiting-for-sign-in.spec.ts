import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

/**
 * A chat whose agent stopped because the provider wanted a sign-in.
 *
 * The owner saw a column of rows reading "Sign-in required" and could not
 * close any of them. Close did put the chat to sleep, but the status check
 * that runs after every command read the open sign-in notice and turned the
 * chat straight back into "stopped", so the row and its close button never
 * changed.
 *
 * Written into the store, like `a-condition-never-eats-an-answer.spec.ts`:
 * no fixture agent fails on sign-in, and the chat only needs the record a
 * failed sign-in leaves behind.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/closing-a-chat-waiting-for-sign-in.spec.ts
 */

const CHAT = '7d2e5a10-4b6c-4f3e-8a91-2c5e0d9b7f41';
const SHOTS = join(process.cwd(), 'tests', 'results');

function seed(projectId: string, projectPath: string) {
  const db = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    const at = new Date('2026-11-14T15:00:00Z').toISOString();
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      `INSERT INTO session
        (id, brand, external_id, project_id, project_path, cwd, model, permission_mode,
         effort, title, state, origin, created_at, last_active_at, ended_at, imported_at,
         imported_recipe, last_spoke_at, followed_to, followed_drawn)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      CHAT, 'claude', null, projectId, projectPath, projectPath, 'claude-opus-5',
      'default', null, 'Waiting for a sign-in', 'stopped', 'app', at, at,
      null, at, null, at, null, null,
    );
    const events = [
      { type: 'message.started', messageId: 'asked', role: 'user' },
      { type: 'text.delta', messageId: 'asked', text: 'look at the ticket' },
      { type: 'message.completed', messageId: 'asked' },
      {
        type: 'provider.message',
        signal: { id: 'condition:authentication', kind: 'authentication', phase: 'active', severity: 'blocking', scope: 'session' },
      },
      { type: 'session.state', state: 'stopped', label: 'Sign-in required', detail: null, call: null },
    ];
    const insert = db.prepare(
      `INSERT INTO event (session_id, seq, at, type, json, provider, provider_thread_id, provider_event_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    events.forEach((event, index) => {
      const seq = index + 1;
      insert.run(CHAT, seq, at, event.type, JSON.stringify({ ...event, sessionId: CHAT, seq, at }), 'claude', null, `sign-in-${seq}`);
    });
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

test('a chat waiting for a sign-in can be closed from its row', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-close-sign-in');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  const made = await request.post('/api/projects', { data: { name: 'Close a sign-in chat', path: fixture } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };
  seed(project.id, project.path);

  try {
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${CHAT}"]`);
    await expect(row.getByTestId('row-name')).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText('Sign-in required', { timeout: 30_000 });
    mkdirSync(SHOTS, { recursive: true });
    await row.screenshot({ path: join(SHOTS, 'close-sign-in-row-before.png') });

    await row.hover();
    await row.getByTestId('row-close').click();
    await page.getByTestId('close-chat-confirm').click();

    await expect
      .poll(async () => row.getAttribute('data-state'), { timeout: 30_000, message: 'closed chat did not fall asleep' })
      .toBe('dormant');
    await row.hover();
    await expect(row.getByTestId('row-close'), 'a closed chat still offers Close').toHaveCount(0);

    // A reload reads the saved state, not the click's own optimism.
    await page.reload();
    await expect(row.getByTestId('row-name')).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => row.getAttribute('data-state'), { timeout: 30_000 }).toBe('dormant');
    await page.mouse.move(0, 0);
    await row.screenshot({ path: join(SHOTS, 'close-sign-in-row-after.png') });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
