import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

/**
 * The chat list on a phone: what a row spends its two lines on.
 *
 * The manager's own report. "remove the 'shut off chat' button that appears
 * inline on mobile, because on mobile that action is already done via the three
 * dots menu" -- the control is drawn over the clock and only under a pointer
 * that hovers, which a thumb has not got, so on a phone it was a place held for
 * a button nobody could summon. "move the time to the second row. make sure the
 * status badge is adjusted accordingly and time doesnt get pushed off the
 * screen by long status messages" (bw-8kk4.1).
 *
 * Driven on a phone-sized screen rather than measured in a unit case, because
 * both halves of this are a width: whether the clock is on the name's line is a
 * media query, and whether a long status pushes it off the edge is what the
 * browser does with the room that is left.
 *
 *   scripts/workbench-e2e.sh tests/e2e/the-chat-rail-on-a-phone.spec.ts
 */
const SHOTS = join(process.cwd(), 'tests', 'results');
const PHONE = { width: 390, height: 844 };

/** A chat and what it is doing, written straight into the record. */
interface Seeded {
  id: string;
  title: string;
  state: string;
  /** The status the row draws, as a state event says it. */
  says: { state: string; label: string; detail: string } | null;
}

const CHATS: Seeded[] = [
  // The hard case: a status long enough to fill the line on its own. If the
  // clock can be pushed off the screen, this is the row that does it.
  {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'The rail, the clock and the status word',
    state: 'running_tool',
    says: {
      state: 'running_tool',
      label: 'Searching',
      detail: 'for NothingShowing|KindFilter in src/workbench/chat-sidebar.tsx',
    },
  },
  // Ours, attached, with nothing in flight: the row that offers Close chat, and
  // so the row that used to draw the control inline.
  {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Ours, attached, and idle',
    state: 'idle',
    says: { state: 'idle', label: '', detail: '' },
  },
  // Asleep: no status at all, and still a time to draw.
  {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Nobody is in this one',
    state: 'dormant',
    says: null,
  },
];

function seed(project: { id: string; path: string }): void {
  const database = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  database.exec('PRAGMA busy_timeout = 5000');
  const at = '2026-09-18T09:14:00Z';
  try {
    database.exec('BEGIN IMMEDIATE');
    const session = database.prepare(
      `INSERT INTO session
         (id, brand, project_id, project_path, cwd, permission_mode, title,
          state, origin, created_at, last_active_at, last_spoke_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insert = database.prepare(
      'INSERT INTO event (session_id, seq, at, type, json) VALUES (?,?,?,?,?)',
    );
    for (const chat of CHATS) {
      session.run(
        chat.id, 'claude', project.id, project.path, project.path, 'default',
        chat.title, chat.state, 'app', at, at, at,
      );
      if (!chat.says) continue;
      const body = { type: 'session.state', sessionId: chat.id, seq: 1, at, ...chat.says };
      insert.run(chat.id, 1, at, 'session.state', JSON.stringify(body));
    }
    database.exec('COMMIT');
  } finally {
    database.close();
  }
}

test('a row on a phone keeps its clock and drops the control a thumb cannot summon', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-rail-on-a-phone');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'The rail on a phone', path: fixture },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };

  try {
    seed(project);
    await page.setViewportSize(PHONE);
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('chat-rail-toggle').click();
    const rail = page.getByTestId('chat-sidebar');
    await expect(rail).toBeVisible({ timeout: 60_000 });
    const rows = CHATS.map((chat) =>
      page.locator(`[data-testid="restore-row"][data-row-key="${chat.id}"]`),
    );
    for (const row of rows) await expect(row.getByTestId('row-name')).toBeVisible({ timeout: 60_000 });

    // Taken before anything is asserted, so a run on a build without this
    // leaves the picture of what the manager was looking at either way.
    mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(500);
    await rail.screenshot({ path: join(SHOTS, 'rail-on-a-phone.png') });

    const edge = (await rail.boundingBox())!;
    for (const [index, row] of rows.entries()) {
      const title = CHATS[index].title;

      // The control a thumb cannot summon is not drawn at all, and the menu
      // that carries the same action in its place is.
      await expect(
        row.getByTestId('row-close'),
        `${title} still drew the inline close control on a phone`,
      ).toBeHidden();
      await expect(row.getByTestId('row-menu'), `${title} has no menu to close it from`).toBeVisible();

      // The clock is on the SECOND line: below the name, not beside it.
      const clock = row.locator('span', { hasText: /^\d{1,2}:\d{2}/ }).last();
      await expect(clock, `${title} lost its time`).toBeVisible();
      const name = (await row.getByTestId('row-name').boundingBox())!;
      const said = (await clock.boundingBox())!;
      expect(said.y, `the time on ${title} is still up on the name's line`).toBeGreaterThanOrEqual(
        name.y + name.height - 1,
      );

      // And the whole of it is on the screen, however long the status is.
      expect(
        said.x + said.width,
        `a long status pushed the time off the edge of ${title}`,
      ).toBeLessThanOrEqual(edge.x + edge.width + 0.5);
      expect(said.x, `the time on ${title} went off the left`).toBeGreaterThanOrEqual(edge.x - 0.5);
    }

    // The long status is the one that had to give: it is cut short rather than
    // taking the line the clock is on.
    const busy = rows[0].getByTestId('row-pill');
    await expect(busy, 'the working row lost the word for what it is doing').toBeVisible();
    const chip = (await busy.boundingBox())!;
    expect(
      chip.x + chip.width,
      'the status chip ran past the rail it is drawn in',
    ).toBeLessThanOrEqual(edge.x + edge.width + 0.5);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
