import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = process.env.BEADS_E2E_OWNER_DB;
const SHOTS = join(process.cwd(), 'tests', 'results');

test.describe.configure({ mode: 'serial' });

const CHATS = [
  {
    id: 'ec075741-1657-4f67-84cb-728deda54c0d',
    title: 'Need Terminal Integration Will Integrate Default',
    shot: 'claude-history-terminal',
  },
  {
    id: '021a4ead-5fae-453e-942a-977a13cb6c70',
    title: 'Claude Sidebar Shows Subagents Done Current',
    shot: 'claude-history-sidebar',
  },
] as const;

function copyChat(chat: (typeof CHATS)[number], project: { id: string; path: string }): number {
  if (!SOURCE) throw new Error('BEADS_E2E_OWNER_DB must name the read-only source workbench.db');
  const source = new DatabaseSync(SOURCE, { readOnly: true });
  const target = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  const session = source.prepare('SELECT * FROM session WHERE id = ?').get(chat.id) as Record<string, unknown> | undefined;
  if (!session) throw new Error(`source database has no chat ${chat.id}`);
  const events = source.prepare('SELECT * FROM event WHERE session_id = ? ORDER BY seq').all(chat.id) as Record<string, unknown>[];

  target.exec('BEGIN IMMEDIATE');
  try {
    target.prepare(
      `INSERT INTO session
        (id, brand, external_id, project_id, project_path, cwd, model,
         permission_mode, effort, title, state, origin, created_at,
         last_active_at, ended_at, imported_at, imported_recipe,
         last_spoke_at, followed_to, followed_drawn)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      session.id, session.brand, session.external_id, project.id, project.path, project.path,
      session.model, session.permission_mode, session.effort, session.title, 'dormant', session.origin,
      session.created_at, session.last_active_at, session.ended_at, session.imported_at,
      session.imported_recipe, session.last_spoke_at, session.followed_to, session.followed_drawn,
    );
    const put = target.prepare(
      `INSERT INTO event
        (session_id, seq, at, type, json, provider, provider_thread_id, provider_event_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const event of events) {
      put.run(
        event.session_id, event.seq, event.at, event.type, event.json,
        event.provider, event.provider_thread_id, event.provider_event_id,
      );
    }
    target.exec('COMMIT');
  } catch (error) {
    target.exec('ROLLBACK');
    throw error;
  } finally {
    target.close();
    source.close();
  }
  return events.length;
}

for (const chat of CHATS) {
  test(`${chat.title} loads older history from an upward gesture at the top`, async ({ page, request }) => {
    test.skip(!SOURCE, 'requires the manager-provided chat database; it is opened read-only');
    test.setTimeout(120_000);
    const fixture = join(process.cwd(), 'tests', `.workbench-run-${chat.shot}`);
    rmSync(fixture, { recursive: true, force: true });
    mkdirSync(fixture, { recursive: true });
    const made = await request.post('/api/projects', {
      data: { name: `Claude history reproduction: ${chat.title}`, path: fixture },
    });
    expect(made.status(), await made.text()).toBe(201);
    const project = (await made.json()) as { id: string; path: string };
    expect(copyChat(chat, project)).toBeGreaterThan(100);

    let olderRequests = 0;
    await page.route('**/api/workbench/history?*', async (route) => {
      if (new URL(route.request().url()).searchParams.has('before')) olderRequests += 1;
      await route.continue();
    });

    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      const row = page.locator(`[data-testid="restore-row"][data-row-key="${chat.id}"]`);
      await expect(row.getByTestId('row-name')).toHaveText(chat.title, { timeout: 30_000 });
      await row.getByTestId('row-name').click();
      await expect(page.getByTestId('chat-loading')).toBeHidden({ timeout: 60_000 });

      const pane = page.getByTestId('transcript');
      const transcript = page.getByTestId('virtual-transcript');
      await expect.poll(async () => Number(await transcript.getAttribute('data-total-items'))).toBeGreaterThan(0);
      const firstRows = Number(await transcript.getAttribute('data-total-items'));
      // One persisted 40-item page can fan out into more drawn machine rows.
      // It must still remain a small initial render, not the whole transcript.
      expect(firstRows).toBeLessThan(100);
      await pane.evaluate((element) => { element.scrollTop = 0; });
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${chat.shot}-before.png`) });

      const requestsBeforeGesture = olderRequests;
      await pane.hover();
      await page.mouse.wheel(0, -1200);
      await expect.poll(
        () => olderRequests - requestsBeforeGesture,
        { message: `${chat.title}: the upward gesture asked for no older history` },
      ).toBe(1);
      // Older parent rows can fold formerly orphaned machine rows, so the
      // drawn count may shrink even though the persisted window grew.
      await expect.poll(async () => Number(await transcript.getAttribute('data-total-items'))).not.toBe(firstRows);
      await page.waitForTimeout(100); // let the prepend anchor finish its measured correction

      const requestsBeforeSecondGesture = olderRequests;
      await pane.evaluate((element) => { element.scrollTop = 0; });
      await pane.hover();
      await page.mouse.wheel(0, -1200);
      await expect.poll(
        () => olderRequests - requestsBeforeSecondGesture,
        { message: `${chat.title}: history stopped after its first older page` },
      ).toBe(1);
      await page.screenshot({ path: join(SHOTS, `${chat.shot}-after.png`) });
    } finally {
      await request.delete(`/api/projects/${project.id}`);
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
