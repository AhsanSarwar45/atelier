import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

/**
 * A chat whose record already holds a condition filed against an answer.
 *
 * The manager installed the change that stopped new ones being written,
 * reloaded, and found it had done nothing for him: "now that i have reloaded
 * the page, that message isn't even visible, neither as normal message nor as
 * the wrong categorized mesage".
 *
 * Both halves of that, and one cause. A `provider.message` carrying
 * `sourceMessageId` DELETED the message it named — in the browser's fold and in
 * the server projection every reload is served from. So the answer went when
 * the condition was filed, and when the next clean turn resolved the condition
 * the notice went too, leaving the gap he reloaded into. Nothing rewrites a
 * stored record, so stopping the writer could never give him his answer back:
 * the READING had to change, and this is the case that holds it (bw-by3w).
 *
 * Written into the store rather than driven, unlike its neighbour
 * `an-answer-is-not-a-condition.spec.ts`. What is proved here is how a record
 * that is ALREADY WRONG reads, and no build writes these events any more —
 * every chat that has them got them before the fix, and they are all he has.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-condition-never-eats-an-answer.spec.ts
 */

/** His own answer, cut to the sentence that was read as a condition. */
const ANSWER =
  "The sidebar now reads the condition's own word — Limit reached, Sign-in required — "
  + 'instead of a blanket Failed, proved on the running screen and not just in tests.';

const CHAT = '3c1f88a2-6d40-4e17-9f2b-51ac7e3d0b64';
const SHOTS = join(process.cwd(), 'tests', 'results');

/** The turn as a build that read every answer's prose recorded it. */
function turnThatWasFiledAsACondition(): { type: string; json: Record<string, unknown> }[] {
  // The instruction that did the damage, on both phases as the driver wrote
  // it. Nothing writes `sourceMessageId` now; every record made before the fix
  // still carries it, and this is what those records must read as.
  const signal = (phase: 'active' | 'resolved') => ({
    id: 'usage:session', kind: 'usage_limit', phase, severity: 'blocking',
    scope: 'session', detail: phase === 'active' ? ANSWER : null, retryAt: null,
    action: null, resets: 'resets 9pm (Asia/Karachi)', sourceMessageId: 'his-answer',
  });
  const spoke = (id: string, role: string, text: string) => [
    { type: 'message.started', json: { type: 'message.started', messageId: id, role } },
    { type: 'text.delta', json: { type: 'text.delta', messageId: id, text } },
    { type: 'message.completed', json: { type: 'message.completed', messageId: id } },
  ];
  return [
    ...spoke('asked', 'user', 'where did the work get to?'),
    ...spoke('his-answer', 'assistant', ANSWER),
    { type: 'provider.message', json: { type: 'provider.message', signal: signal('active') } },
    // The turn after it finished cleanly, which resolved the condition — and
    // took the notice with it, leaving nothing where the answer had been.
    { type: 'provider.message', json: { type: 'provider.message', signal: signal('resolved') } },
  ];
}

test('an answer a stored condition was filed against is drawn again', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-condition-ate-an-answer');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'A condition never eats an answer', path: fixture },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };

  const db = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    const at = new Date('2026-09-04T15:00:00Z').toISOString();
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      `INSERT INTO session
        (id, brand, external_id, project_id, project_path, cwd, model, permission_mode,
         effort, title, state, origin, created_at, last_active_at, ended_at, imported_at,
         imported_recipe, last_spoke_at, followed_to, followed_drawn)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      CHAT, 'claude', null, project.id, project.path, project.path, 'claude-opus-5',
      'default', null, 'The answer a condition was filed against', 'dormant', 'app', at, at,
      null, at, null, at, null, null,
    );
    const insert = db.prepare(
      `INSERT INTO event (session_id, seq, at, type, json, provider, provider_thread_id, provider_event_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    turnThatWasFiledAsACondition().forEach((event, index) => {
      const seq = index + 1;
      insert.run(
        CHAT, seq, at, event.type,
        JSON.stringify({ ...event.json, sessionId: CHAT, seq, at }),
        'claude', null, `filed-${seq}`,
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

    // Waited on by the question he asked, not by the answer: a build that eats
    // the answer must still reach the picture rather than time out in front of
    // it, or the before shot is of a spinner and proves nothing.
    const transcript = page.getByTestId('virtual-transcript');
    await expect
      .poll(
        async () => broke.length > 0 || Number(await transcript.getAttribute('data-total-items')) > 0,
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(broke, `the transcript threw while drawing: ${broke.join('; ')}`).toEqual([]);
    await expect(page.getByTestId('working-line')).toBeHidden({ timeout: 120_000 });
    await expect(page.getByText('where did the work get to?')).toBeVisible({ timeout: 30_000 });

    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({
      path: join(SHOTS, process.env.THE_CONDITION_ATE_IT ? 'bw-by3w-before.png' : 'bw-by3w-after.png'),
      fullPage: false,
    });

    // The whole of it: his answer is on the page, in his agent's own words.
    await expect(
      page.getByTestId('assistant-message').filter({ hasText: 'Limit reached, Sign-in required' }),
      'the answer a stored condition was filed against is still missing',
    ).toHaveCount(1);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
