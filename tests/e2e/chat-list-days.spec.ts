/**
 * The days over the chat list are in order, and stay in order while he works.
 *
 * The manager's screenshot, 2026-09-04: YESTERDAY over seven rows, and TODAY
 * over one row below them — a chat he had begun the afternoon before and spoken
 * in again that morning. Its clock, its time and its day had all moved on; only
 * its PLACE was a day old, because the list holds every row it has already
 * drawn exactly where it drew it, so his own message could change the heading
 * over a row without moving the row out from under the old one (bw-hgd2).
 *
 * It has to be driven, and it cannot be reloaded. The freeze lives in the page:
 * it is the order the list last drew, remembered while the tab is open, and
 * re-opening the list is precisely what settles it again. So this case opens
 * the list once, lets it settle on yesterday's chats, and then says one thing
 * into one of them from OUTSIDE the app — the record grows on disk, the sidecar
 * says so, the list re-reads itself — which is the whole of what the manager
 * did.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-list-days.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { discardFixture, makeFixtureProject } from './fixture-board';
import { writeChatSpokenAt } from './fixture-record';

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** Reading the chats off disk is a scan of the kit's own records. */
const LISTED_MS = 120_000;

/** A folder of this case's own, so it never reads anybody's real work. */
const RUN = join(__dirname, '..', '.workbench-run-days');
const PROJECT = join(RUN, 'project');

/** Yesterday at a given hour, by the clock the reader's own screen runs on. */
function yesterdayAt(hour: number): Date {
  const when = new Date();
  when.setDate(when.getDate() - 1);
  when.setHours(hour, 0, 0, 0);
  return when;
}

/** What the helper says one chat's clock is, by the reading the list runs on. */
async function spokenAt(request: APIRequestContext, project: string, chat: string): Promise<string | null> {
  const res = await request.get(`/api/workbench/restore?project=${project}&path=${encodeURIComponent(PROJECT)}`);
  const rows = (await res.json()) as { externalId: string | null; lastActiveAt: string; lastSpokeAt?: string | null }[];
  const row = rows.find((r) => r.externalId === chat);
  return row ? (row.lastSpokeAt ?? row.lastActiveAt) : null;
}

async function projectAt(request: APIRequestContext, path: string): Promise<{ id: string; path: string }> {
  const there = async (): Promise<{ id: string; path: string } | undefined> => {
    const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
      id: string;
      path: string;
    }[];
    return listed.find((p) => p.path === path);
  };
  const found = await there();
  if (found) return found;
  const made = await request.post('/api/projects', { data: { name: 'workbench-days', path, isTest: true } });
  if (made.status() === 201) return (await made.json()) as { id: string; path: string };
  const said = await made.text();
  const raced = await there();
  expect(raced, `no project at ${path}, and it could not be made: ${said}`).toBeTruthy();
  return raced!;
}

test.describe('the days over the chat list', () => {
  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    discardFixture(RUN);
    mkdirSync(RUN, { recursive: true });
  });
  test.describe.configure({ timeout: 300_000 });

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('a chat he speaks in this morning leaves yesterday and stands under Today', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    makeFixtureProject(PROJECT, join(RUN, 'reporting'));
    const project = await projectAt(request, PROJECT);

    // Three chats of yesterday's, an evening apart, so the block below has an
    // order of its own to keep. The middle one is the one he comes back to.
    const evening = writeChatSpokenAt({ cwd: PROJECT, sessionId: randomUUID(), at: yesterdayAt(22), name: 'Worktree cleanup' });
    const afternoon = writeChatSpokenAt({ cwd: PROJECT, sessionId: randomUUID(), at: yesterdayAt(16), name: 'App performance' });
    const early = writeChatSpokenAt({ cwd: PROJECT, sessionId: randomUUID(), at: yesterdayAt(13), name: 'Hook friction' });

    const days = page.getByTestId('day-heading');
    const rowKeys = async (): Promise<(string | null)[]> =>
      page.locator('[data-testid="restore-row"]').evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-external-id')),
      );

    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: LISTED_MS });
      for (const chat of [evening, afternoon, early]) {
        await page
          .locator(`[data-testid="restore-row"][data-external-id="${chat.sessionId}"]`)
          .waitFor({ timeout: LISTED_MS });
      }

      // ---- the list as it settles: one day, three rows under it -----------
      await expect(days).toHaveText(['Yesterday']);
      expect(await rowKeys()).toEqual([evening.sessionId, afternoon.sessionId, early.sessionId]);
      await page.screenshot({ path: join(SHOTS, 'chat-days-settled.png'), fullPage: false });

      // ---- and then he speaks in the middle one, from outside the app ------
      // Nothing is reloaded and nothing is clicked: the record grows on disk,
      // which is what a chat resumed in a terminal does, and the list hears it.
      // What that chat's clock read before he did, so the wait below is on the
      // helper having taken his message in rather than on a stretch of time.
      const before = await spokenAt(request, project.id, afternoon.sessionId);
      expect(before, 'the helper does not know the chat this case is about').toBeTruthy();
      afternoon.saysAgain();

      // Waited on at the helper first, because one discovery answer serves
      // every reader for five seconds (workbench.rs, DISCOVERY_FRESH): the
      // list's own re-read lands inside that window and is answered from
      // before the message. So the case waits for the helper itself to have
      // caught up, and the agent's reply — the next thing a live chat writes —
      // is what sends the list back to ask again.
      await expect
        .poll(async () => (await spokenAt(request, project.id, afternoon.sessionId)) !== before, {
          timeout: LISTED_MS,
        })
        .toBe(true);
      afternoon.agentAnswers();

      // First that the list has heard him at all — a second day is drawn,
      // whichever way round. The picture is taken here, so a run that draws
      // them the wrong way round leaves the proof of it rather than only a
      // failure (bw-hgd2).
      await expect(days, 'the day he spoke on never reached the list').toHaveCount(2, { timeout: LISTED_MS });
      await page.screenshot({ path: join(SHOTS, 'chat-days-after-he-speaks.png'), fullPage: false });

      // And then that it is the right way round.
      await expect(days, 'today was drawn under yesterday').toHaveText(['Today', 'Yesterday']);
      // The row itself moved, rather than a second heading being drawn where it
      // had been sitting: it is first, above every row still dated yesterday.
      expect(await rowKeys()).toEqual([afternoon.sessionId, evening.sessionId, early.sessionId]);
      // And the two he did not touch did not trade places under his hand.
      const yesterday = page.locator('[data-testid="day-heading"]:has-text("Yesterday") ~ *');
      await expect(yesterday.first()).toHaveAttribute('data-external-id', evening.sessionId);
    } finally {
      for (const chat of [evening, afternoon, early]) chat.remove();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
