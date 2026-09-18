import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

import { quadrantPng } from './fixture-png';

/**
 * A reopened chat on a phone: the picture a call answered with is still there,
 * and a table too wide for the screen is pushed sideways instead of crushed.
 *
 * Both are the manager's own report. "images dont show when we reload a chat
 * (the images that usually show when agent reads an image)" -- the picture
 * rides an event that names the CALL and leaves `messageId` null, and every
 * road a reopened chat takes into the record looked for a message, so the
 * picture was on the screen while the chat was live and gone the moment it was
 * read back (bw-343e.1). "tables arr too cramped cureently on mobile ... the
 * columns should be horizontally scrollable inside the table" -- a table never
 * narrows past its min-content width, so on a phone every column collapsed to
 * its longest word (bw-343e.2).
 *
 * The chat is written straight into the record because that is the only way to
 * be reading rather than watching: a chat this app drove is drawn by the
 * browser's own fold of the live stream, which never had either fault.
 */
const CHAT = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
const SHOTS = join(process.cwd(), 'tests', 'results');

/**
 * The picture, the shape a call answers with: a mime type, the bytes, a word.
 *
 * Four coloured quadrants, so a screenshot cannot be argued with -- a blank
 * square proves nothing about whether a picture was drawn or merely reserved.
 */
const PICTURE = {
  mime: 'image/png',
  dataUrl: `data:image/png;base64,${quadrantPng(180).toString('base64')}`,
  alt: 'Tool image',
};

/** Wide enough that no phone can hold it, and every column worth reading. */
const TABLE = [
  '| Card | Area | Who is on it | What it is waiting for | Landed |',
  '| --- | --- | --- | --- | --- |',
  '| bw-343e.1 | workbench | the reload session | a screenshot of a reopened chat | not yet |',
  '| bw-343e.2 | workbench | the reload session | a screenshot taken on a phone | not yet |',
  '| bw-t26l.20 | workbench | closed last month | nothing, it is done | yes |',
].join('\n');

function seed(project: { id: string; path: string }): void {
  const database = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  database.exec('PRAGMA busy_timeout = 5000');
  const at = '2026-09-18T09:00:00Z';
  try {
    database.exec('BEGIN IMMEDIATE');
    database
      .prepare(
        `INSERT INTO session
           (id, brand, project_id, project_path, cwd, permission_mode, title,
            state, origin, created_at, last_active_at, last_spoke_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        CHAT, 'claude', project.id, project.path, project.path, 'default',
        'What the agent looked at', 'dormant', 'app', at, at, at,
      );
    const insert = database.prepare(
      'INSERT INTO event (session_id, seq, at, type, json) VALUES (?,?,?,?,?)',
    );
    const told: Record<string, unknown>[] = [
      { type: 'tool.started', toolCallId: 'read', name: 'Read', title: 'Read board.png' },
      // The picture names the CALL. `messageId` is null, and that is the whole
      // of what went missing.
      { type: 'image', messageId: null, toolCallId: 'read', image: PICTURE },
      { type: 'tool.completed', toolCallId: 'read', ok: true },
      { type: 'message.started', messageId: 'said', role: 'assistant' },
      { type: 'text.delta', messageId: 'said', text: `Here is what the board holds:\n\n${TABLE}\n` },
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

test('a reopened chat on a phone keeps its picture and pushes its table sideways', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-reopened-on-a-phone');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'Reopened on a phone', path: fixture },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };

  const broke: string[] = [];
  page.on('pageerror', (error) => broke.push(String(error)));

  try {
    seed(project);
    // Opened from the list on a screen wide enough to hold it, then RELOADED
    // at the width of a phone. The reload is the whole point: it is the second
    // reading of the record, the one the browser's live fold never touches.
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${CHAT}"]`);
    await expect(row.getByTestId('row-name')).toBeVisible({ timeout: 60_000 });
    await row.getByTestId('row-name').scrollIntoViewIfNeeded();
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 120_000 });
    const address = page.url();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(address);
    await expect(page.getByTestId('chat-loading')).toBeHidden({ timeout: 120_000 });

    // Taken before anything is asserted, so a run on a build without the fix
    // still leaves the picture of what the manager was looking at.
    mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: join(SHOTS, 'reopened-on-a-phone.png'), fullPage: true });

    // The picture the call answered with, drawn on the call's own row.
    const picture = page.locator(`img[src="${PICTURE.dataUrl}"]`);
    await expect(picture).toBeVisible({ timeout: 60_000 });
    expect(broke, `the transcript threw while drawing: ${broke.join('; ')}`).toEqual([]);

    // The table scrolls INSIDE itself: it is wider than its own box, and the
    // page behind it has not been pushed wider than the phone.
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 60_000 });
    const box = await table.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      overflowX: getComputedStyle(node).overflowX,
    }));
    expect(box.overflowX, 'the table is its own sideways scroller').toMatch(/auto|scroll/);
    expect(
      box.scrollWidth,
      `the table has somewhere to scroll to: ${JSON.stringify(box)}`,
    ).toBeGreaterThan(box.clientWidth + 1);

    // Pushed along, the far column comes into view and the page stays put.
    await table.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    await expect(page.getByText('Landed')).toBeInViewport({ timeout: 10_000 });
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth, 'the page itself never scrolls sideways').toBeLessThanOrEqual(391);
    await page.screenshot({ path: join(SHOTS, 'reopened-on-a-phone-scrolled.png'), fullPage: true });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
