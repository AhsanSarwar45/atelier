import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

/**
 * A chat whose record holds calls that were announced before their arguments.
 *
 * ACP sends `tool_call` when the agent starts a call and `tool_call_update`
 * with `rawInput` once it knows what the call was given, so a started call
 * legitimately has no arguments yet. The normalizer handed that absence
 * straight through as `"input": null`, the projection copied it into the
 * window the browser opens on, and the first row drawn off it took the whole
 * transcript down: every reader of a row — the language of it, the addresses
 * in it, the sentence it is titled with — reads a key off `input` without
 * asking whether it is an object.
 *
 * The manager's own record is the case. One chat on this machine holds 877
 * such calls, and it is the chat that would not open (bw-t26l.20).
 */
const SOURCE = process.env.BEADS_E2E_OWNER_DB;
const CHAT = 'e855e8cd-3ffe-41bb-810e-19d48bcaef40';
const SHOTS = join(process.cwd(), 'tests', 'results');

/** Copies the chat AND its normalized events: the null is in the record. */
function copyChat(project: { id: string; path: string }): { events: number; announced: number } {
  if (!SOURCE) throw new Error('BEADS_E2E_OWNER_DB must name the read-only source workbench.db');
  const source = new DatabaseSync(SOURCE, { readOnly: true });
  const target = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  target.exec('PRAGMA busy_timeout = 5000');
  try {
    const session = source.prepare('SELECT * FROM session WHERE id = ?').get(CHAT) as
      | Record<string, unknown>
      | undefined;
    if (!session) throw new Error(`source database has no chat ${CHAT}`);
    const events = source
      .prepare('SELECT * FROM event WHERE session_id = ? ORDER BY seq')
      .all(CHAT) as Record<string, unknown>[];
    const announced = events.filter(
      (event) =>
        event.type === 'tool.started' &&
        (JSON.parse(String(event.json)) as { input?: unknown }).input === null,
    ).length;

    target.exec('BEGIN IMMEDIATE');
    target
      .prepare(
        `INSERT INTO session
          (id, brand, external_id, project_id, project_path, cwd, model,
           permission_mode, effort, title, state, origin, created_at,
           last_active_at, ended_at, imported_at, imported_recipe,
           last_spoke_at, followed_to, followed_drawn)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        session.id, session.brand, null, project.id, project.path, project.path,
        session.model, session.permission_mode, session.effort, session.title, 'dormant',
        session.origin, session.created_at, session.last_active_at, session.ended_at,
        session.last_active_at, session.imported_recipe, session.last_spoke_at, null, null,
      );
    const insert = target.prepare(
      `INSERT INTO event (session_id, seq, at, type, json, provider, provider_thread_id, provider_event_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const event of events) {
      insert.run(
        event.session_id, event.seq, event.at, event.type, event.json,
        event.provider, event.provider_thread_id, event.provider_event_id,
      );
    }
    target.exec('COMMIT');
    return { events: events.length, announced };
  } finally {
    target.close();
    source.close();
  }
}

test('a chat holding calls announced before their arguments still draws', async ({ page, request }) => {
  test.skip(!SOURCE, 'requires the manager-provided chat database; it is opened read-only');
  test.setTimeout(180_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-acp-call-without-arguments');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'ACP call announced before its arguments', path: fixture },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };

  const copied = copyChat(project);
  // Without a call whose arguments the record never carried, this case would
  // pass on a build that still hands the null through.
  expect(copied.announced, 'the copied chat carries no argumentless call').toBeGreaterThan(0);
  expect(copied.events).toBeGreaterThan(100);

  // The crash was an uncaught TypeError while the page was loading, which
  // leaves a blank transcript rather than a failed assertion. Catch it.
  const broke: string[] = [];
  page.on('pageerror', (error) => broke.push(String(error)));

  try {
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${CHAT}"]`);
    await expect(row.getByTestId('row-name')).toBeVisible({ timeout: 60_000 });
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('chat-loading')).toBeHidden({ timeout: 120_000 });

    // A transcript that threw stays empty forever, so waiting only on the row
    // count reports a timeout and never the reason. Give up on the first
    // uncaught error instead, and say what it was.
    const transcript = page.getByTestId('virtual-transcript');
    await expect
      .poll(
        async () => broke.length > 0 || Number(await transcript.getAttribute('data-total-items')) > 0,
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(broke, `the transcript threw while drawing: ${broke.join('; ')}`).toEqual([]);
    expect(Number(await transcript.getAttribute('data-total-items'))).toBeGreaterThan(0);

    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'acp-call-without-arguments.png') });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
