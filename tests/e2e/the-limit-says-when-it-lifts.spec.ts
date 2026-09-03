import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

/**
 * A chat stopped by its own session limit, drawn as the manager found it.
 *
 * He sent two screenshots of the same condition on 2026-09-03: "this you've hit
 * your limit is werid all around. some places its hows the yello message box
 * with reset time, somplaces it doesnt". In one there was a single bordered
 * notice reading `You've hit your session limit` and nothing more; in the other
 * that notice AND, underneath it, the provider's own sentence — the same fact,
 * differently worded, and the only one of the two that said when it lifts.
 *
 * The events below are the shape his own record holds, taken from chat
 * `e6d3753d` at seq 5875-5896 (11 usage limits across that database, every one
 * of them with `retryAt` null). Written rather than driven: what is proved here
 * is how a stored turn READS, and the state that produced his second screenshot
 * is a message whose completion had not yet arrived — the driver files the
 * condition then, and there his lagged the words by eighteen events and a whole
 * turn of his own typing. A run against a live provider cannot be made to sit
 * in that window on demand, and would need a real limit to be hit to get there.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-limit-says-when-it-lifts.spec.ts
 */

/** What the provider says, and the only place the time was ever written down. */
const SAID = "You've hit your session limit · resets 9pm (Asia/Karachi)";

/**
 * The wire string the failed turn wrote as well, and printed in red under all
 * of it. Kept in the record because his has it, though it is not what this case
 * reads: a chat clears it as soon as an agent attaches, so it is only on screen
 * while the chat sits untouched. That the driver no longer WRITES it is held by
 * `acp/normalize.rs`, where writing it was the fault.
 */
const WIRE = `Internal error: ${SAID}: {\n  "errorKind": "rate_limit"\n}`;

const CHAT = '11111111-2222-3333-4444-555555555555';
const SHOTS = join(process.cwd(), 'tests', 'results');

/** The turn as the driver recorded it, in the order it recorded it. */
function turnThatHitTheLimit(): { type: string; json: Record<string, unknown> }[] {
  const spoke = (id: string, role: string, text: string) => [
    { type: 'message.started', json: { type: 'message.started', messageId: id, role } },
    { type: 'text.delta', json: { type: 'text.delta', messageId: id, text } },
  ];
  return [
    ...spoke('asked', 'user', 'carry on with the audit'),
    { type: 'message.completed', json: { type: 'message.completed', messageId: 'asked' } },
    // The turn the provider refused. Its sentence is replaced by the condition
    // it means, because the signal names it as its source.
    ...spoke('acp-said-once', 'assistant', SAID),
    { type: 'message.completed', json: { type: 'message.completed', messageId: 'acp-said-once' } },
    {
      type: 'provider.message',
      json: {
        type: 'provider.message',
        signal: {
          id: 'usage:session', kind: 'usage_limit', phase: 'active', severity: 'blocking',
          // No instant: the provider named a wall clock in a zone, which is
          // what all eleven of these in his own database did. `resets` is what
          // the driver reads off that sentence at the boundary, so a record
          // written before this change carries a bare notice for ever.
          scope: 'session', detail: SAID, retryAt: null, action: null,
          resets: 'resets 9pm (Asia/Karachi)',
          sourceMessageId: 'acp-said-once',
        },
      },
    },
    { type: 'error', json: { type: 'error', message: WIRE, fatal: false, source: 'acp' } },
    // The next attempt, still mid-flight: the words are recorded and the
    // completion that would file them as a condition has not arrived. This is
    // the state of his second screenshot.
    ...spoke('acp-said-again', 'assistant', SAID),
  ];
}

test('a chat stopped by its limit says so once, and says when it lifts', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-limit-lifts');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'A limit that says when it lifts', path: fixture },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };

  const db = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    const at = new Date('2026-09-03T15:00:00Z').toISOString();
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      `INSERT INTO session
        (id, brand, external_id, project_id, project_path, cwd, model, permission_mode,
         effort, title, state, origin, created_at, last_active_at, ended_at, imported_at,
         imported_recipe, last_spoke_at, followed_to, followed_drawn)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      CHAT, 'claude', null, project.id, project.path, project.path, 'claude-opus-5',
      'default', null, 'The audit that hit a limit', 'dormant', 'app', at, at,
      null, at, null, at, null, null,
    );
    const insert = db.prepare(
      `INSERT INTO event (session_id, seq, at, type, json, provider, provider_thread_id, provider_event_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    turnThatHitTheLimit().forEach((event, index) => {
      const seq = index + 1;
      insert.run(
        CHAT, seq, at, event.type,
        JSON.stringify({ ...event.json, sessionId: CHAT, seq, at }),
        'claude', null, `limit-${seq}`,
      );
    });
    db.exec('COMMIT');
  } finally {
    db.close();
  }

  const broke: string[] = [];
  page.on('pageerror', (error) => broke.push(String(error)));

  try {
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${CHAT}"]`);
    await expect(row.getByTestId('row-name')).toBeVisible({ timeout: 60_000 });
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('chat-loading')).toBeHidden({ timeout: 120_000 });

    const transcript = page.getByTestId('virtual-transcript');
    await expect
      .poll(
        async () => broke.length > 0 || Number(await transcript.getAttribute('data-total-items')) > 0,
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(broke, `the transcript threw while drawing: ${broke.join('; ')}`).toEqual([]);

    // Opening a dormant chat attaches an agent to it, and until that has
    // settled the pane still carries the starting line. Waited out rather than
    // raced, so two runs of this case are photographs of the same moment.
    await expect(page.getByTestId('working-line')).toBeHidden({ timeout: 120_000 });

    const notice = page.locator('[data-testid="note-row"][data-note-kind="provider/usage_limit"]');
    await expect(notice).toHaveCount(1, { timeout: 30_000 });

    // Taken before the reading below, so a build that draws this wrong leaves
    // the picture of what it drew rather than only the sentence that failed.
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'bw-gao7-limit-after.png'), fullPage: false });

    // One row for the condition, not two, and it is the condition that stands:
    // the provider's own sentence is what the notice was written to replace.
    await expect(page.locator('[data-testid="note-row"][data-note-kind="kit/limit_reached"]')).toHaveCount(0);

    // And it says when the limit lifts, which is the whole of what the reader
    // can act on.
    await expect(notice).toContainText('resets 9pm (Asia/Karachi)');
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
