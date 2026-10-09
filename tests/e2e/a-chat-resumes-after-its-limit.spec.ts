import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

/**
 * A chat stopped by a usage limit resumes on its own a minute after the limit
 * resets, once the owner has turned that on in Settings → Usage limits.
 *
 * Three chats are written straight into the store, each stopped by a usage
 * limit: one whose limit resets a few seconds after the switch is turned on,
 * which should be sent `continue` a minute later; one whose reset is hours
 * away, which should only say when it will resume; and one whose limit reset
 * days before the switch was turned on, which should be left alone. Written rather than driven, as in
 * `the-limit-says-when-it-lifts.spec.ts`: a live provider cannot be made to
 * hit its limit on demand.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-chat-resumes-after-its-limit.spec.ts
 */

const PAST = '11111111-2222-3333-4444-000000000001';
const LATER = '11111111-2222-3333-4444-000000000002';
const OLD = '11111111-2222-3333-4444-000000000003';
const SHOTS = join(process.cwd(), 'tests', 'results');

function limited(retryAt: string) {
  const said = "You've hit your session limit";
  return [
    { type: 'message.started', json: { type: 'message.started', messageId: 'asked', role: 'user' } },
    { type: 'text.delta', json: { type: 'text.delta', messageId: 'asked', text: 'carry on with the audit' } },
    { type: 'message.completed', json: { type: 'message.completed', messageId: 'asked' } },
    {
      type: 'provider.message',
      json: {
        type: 'provider.message',
        signal: {
          id: 'usage:session', kind: 'usage_limit', phase: 'active', severity: 'blocking',
          scope: 'session', detail: said, retryAt, action: null, resets: null,
        },
      },
    },
  ];
}

test('a chat stopped by a usage limit resumes once the limit resets', async ({ page, request }) => {
  test.setTimeout(360_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-limit-resume');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  const made = await request.post('/api/projects', { data: { name: 'Resume after a limit', path: fixture } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };

  const db = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  const noticed = new Date(Date.now() - 6 * 24 * 3600_000).toISOString();
  const chats: [string, string, string][] = [
    [PAST, 'The audit whose limit reset', new Date(Date.now() + 20_000).toISOString()],
    [LATER, 'The audit still waiting', new Date(Date.now() + 3 * 3600_000).toISOString()],
    [OLD, 'The audit from last week', new Date(Date.now() - 5 * 24 * 3600_000).toISOString()],
  ];
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const [id, title, retryAt] of chats) {
      db.prepare(
        `INSERT INTO session
          (id, brand, external_id, project_id, project_path, cwd, model, permission_mode,
           effort, title, state, origin, created_at, last_active_at, ended_at, imported_at,
           imported_recipe, last_spoke_at, followed_to, followed_drawn)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, 'claude', null, project.id, project.path, project.path, 'claude-opus-5',
        'default', null, title, 'dormant', 'app', noticed, noticed,
        null, noticed, null, noticed, null, null,
      );
      const insert = db.prepare(
        `INSERT INTO event (session_id, seq, at, type, json, provider, provider_thread_id, provider_event_id)
         VALUES (?,?,?,?,?,?,?,?)`,
      );
      limited(retryAt).forEach((event, index) => {
        const seq = index + 1;
        insert.run(id, seq, noticed, event.type, JSON.stringify({ ...event.json, sessionId: id, seq, at: noticed }),
          'claude', null, `limit-${id}-${seq}`);
      });
    }
    db.exec('COMMIT');

    // Turned on the way the owner would: in Settings.
    await page.goto('/settings?section=limits');
    const toggle = page.getByTestId('limit-auto-resume');
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 60_000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'bw-tqu1r-limit-setting.png') });
    await page.reload();
    await expect(page.getByTestId('limit-auto-resume')).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });

    // The chat whose reset passed is sent `continue`.
    await expect
      .poll(
        () =>
          (db.prepare(
            `SELECT COUNT(*) AS n FROM event WHERE session_id=? AND seq > 4 AND json LIKE '%"continue"%'`,
          ).get(PAST) as { n: number }).n,
        { timeout: 150_000, intervals: [2_000] },
      )
      .toBeGreaterThan(0);

    // The limit that reset before the switch was turned on is left alone.
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM event WHERE session_id=? AND seq > 4`).get(OLD) as { n: number }).n,
    ).toBe(0);

    // The chat still waiting says when it will resume, and is not sent anything.
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${LATER}"]`);
    await expect(row.getByTestId('row-name')).toBeVisible({ timeout: 60_000 });
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('chat-loading')).toBeHidden({ timeout: 120_000 });
    await expect(page.getByText(/^Auto-resume at /)).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: join(SHOTS, 'bw-tqu1r-limit-announced.png') });
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM event WHERE session_id=? AND json LIKE '%"continue"%'`).get(LATER) as {
        n: number;
      }).n,
    ).toBe(0);

    // And the resumed chat shows what it was sent.
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const resumed = page.locator(`[data-testid="restore-row"][data-row-key="${PAST}"]`);
    await expect(resumed.getByTestId('row-name')).toBeVisible({ timeout: 60_000 });
    await resumed.getByTestId('row-name').click();
    await expect(page.getByTestId('chat-loading')).toBeHidden({ timeout: 120_000 });
    await expect(page.getByTestId('virtual-transcript').getByText('continue', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.screenshot({ path: join(SHOTS, 'bw-tqu1r-limit-resumed.png') });
  } finally {
    db.close();
    await request.put('/api/settings/limits', { data: { autoResume: false } });
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
