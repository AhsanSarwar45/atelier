import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

/**
 * How a chat row sits in its own box on a phone.
 *
 * The manager's own report, off the running rail: "the padding on top and on
 * bottom of each card is very different. the visual gap between the name row
 * and the time row is also too much. gives it a weird rough look" (bw-2fhj).
 *
 * All three complaints are one measurement. The row is two lines with eight
 * pixels of padding either side of them, so it should sit square; what pushed
 * it out of square was the thumb-sized floor landing on the menu button at the
 * end of the name's line. A 44px control on a 20px line makes the LINE 44px,
 * and the name, centred in it, ends up with twelve pixels of nothing above it
 * that the time on the second line has not got below. The same twelve pixels
 * are the seam between the two lines.
 *
 * So what is checked here is the line, not the button: the name's line is as
 * tall as the name, the air above the first line and under the second match,
 * and the two lines sit a line's gap apart. The menu button is checked
 * separately for the press it answers, because the fix takes its painted floor
 * away and gives it a band instead — a row that came out square by making the
 * button unhittable would be the same bug wearing the fix's clothes.
 *
 *   scripts/workbench-e2e.sh tests/e2e/a-chat-row-sits-evenly-on-a-phone.spec.ts
 */
const SHOTS = join(process.cwd(), 'tests', 'results');
const PHONE = { width: 390, height: 844 };

/** The smallest a control may be where the pointer is a thumb (globals.css). */
const TAP = 44;

/**
 * A phone is a TOUCH screen, and that is what this case turns on: the floor
 * that inflates the name's line is written `@media (pointer: coarse)`, so a
 * phone-sized window driven by a mouse draws a 28px line and shows none of
 * what the manager photographed. `hasTouch` is what makes the pointer coarse.
 */
test.use({ hasTouch: true, isMobile: true });

interface Seeded {
  id: string;
  title: string;
  state: string;
  says: { state: string; label: string; detail: string } | null;
}

const CHATS: Seeded[] = [
  {
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    title: 'A chat with a status under it',
    state: 'running_tool',
    says: { state: 'running_tool', label: 'Searching', detail: 'for the row rhythm' },
  },
  {
    id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    title: 'Ours, attached, and idle',
    state: 'idle',
    says: { state: 'idle', label: '', detail: '' },
  },
  // Asleep: the second line is a time and nothing else, which is the row the
  // manager's picture is mostly made of.
  {
    id: 'cccccccc-3333-4333-8333-cccccccccccc',
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

test('a chat row sits square in its own box, with its two lines a line apart', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-row-sits-evenly');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'A row that sits evenly', path: fixture },
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
    for (const chat of CHATS) {
      await expect(
        page.locator(`[data-testid="restore-row"][data-row-key="${chat.id}"]`).getByTestId('row-name'),
      ).toBeVisible({ timeout: 60_000 });
    }

    // Taken before anything is asserted, so a red run still leaves the picture
    // of what the manager was looking at.
    mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(500);
    await rail.screenshot({ path: join(SHOTS, 'row-sits-evenly.png') });

    for (const chat of CHATS) {
      const row = page.locator(`[data-testid="restore-row"][data-row-key="${chat.id}"]`);
      const measured = await row.evaluate((el) => {
        const box = (node: Element) => node.getBoundingClientRect();
        const row = box(el);
        const first = box(el.querySelector('[data-testid="row-line-name"]')!);
        const second = box(el.querySelector('[data-testid="row-line-status"]')!);
        const name = box(el.querySelector('[data-testid="row-name"] span')!);
        return {
          above: first.top - row.top,
          below: row.bottom - second.bottom,
          between: second.top - first.bottom,
          firstLine: first.height,
          nameLine: name.height,
        };
      });
      const where = `on "${chat.title}"`;

      // The first line is a line of text, not a band a control stretched.
      expect(
        Math.round(measured.firstLine),
        `${where} the name's line is ${Math.round(measured.firstLine)}px tall for a ` +
          `${Math.round(measured.nameLine)}px name, so the name floats in the middle of it`,
      ).toBeLessThanOrEqual(Math.round(measured.nameLine) + 1);

      // Square in its box: the same air above the first line as under the last.
      expect(
        Math.abs(measured.above - measured.below),
        `${where} there are ${measured.above.toFixed(1)}px above the row's first line and ` +
          `${measured.below.toFixed(1)}px under its last`,
      ).toBeLessThanOrEqual(1);

      // And the two lines are one line's gap apart, not a seam.
      expect(
        measured.between,
        `${where} the name and the line under it are ${measured.between.toFixed(1)}px apart, ` +
          `which reads as a gap between two rows rather than inside one`,
      ).toBeLessThanOrEqual(6);
      expect(measured.between, `${where} the two lines are touching`).toBeGreaterThanOrEqual(0);
    }

    // The button whose painted floor was taken away still answers a thumb, and
    // answers it on its own middle rather than on the row's.
    for (const chat of CHATS) {
      const row = page.locator(`[data-testid="restore-row"][data-row-key="${chat.id}"]`);
      const menu = row.getByTestId('row-menu');
      const reach = await menu.evaluate((el) => {
        const band = getComputedStyle(el, '::before');
        const box = el.getBoundingClientRect();
        return {
          tall: Math.max(box.height, parseFloat(band.height) || 0),
          wide: Math.max(box.width, parseFloat(band.width) || 0),
        };
      });
      expect(
        Math.round(reach.tall),
        `the menu on "${chat.title}" is only ${Math.round(reach.tall)}px to a thumb`,
      ).toBeGreaterThanOrEqual(TAP);
      expect(
        Math.round(reach.wide),
        `the menu on "${chat.title}" is only ${Math.round(reach.wide)}px wide to a thumb`,
      ).toBeGreaterThanOrEqual(TAP);
    }

    // And the press lands on it: a band is only a target if the row under it
    // does not take the tap first.
    const last = page.locator(`[data-testid="restore-row"][data-row-key="${CHATS[2].id}"]`);
    const painted = (await last.getByTestId('row-menu').boundingBox())!;
    // Eight pixels above the painted top: outside the icon, inside the band,
    // which reaches twelve past it. A press here is one that would have missed
    // before the button was given a band of its own.
    await page.mouse.click(painted.x + painted.width / 2, painted.y - 8);
    await expect(
      page.getByTestId('chat-menu-copy-id'),
      'a press on the top of the menu button’s band did not open the menu',
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
