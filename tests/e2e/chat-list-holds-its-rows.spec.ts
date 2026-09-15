/**
 * A chat the list has drawn stays drawn while a session in the project works.
 *
 * The manager's report, 2026-09-15, on Aspen: every chat below Sep 10 kept
 * vanishing for a moment and coming back. The list asks twice on every re-read:
 * a quick local answer from the app's own store, then the full one with what
 * provider discovery finds. A running chat makes the list re-read about once a
 * second, and each quick answer used to replace a full list already drawn —
 * dropping every chat only discovery carries until the full answer came back
 * (bw-0nie).
 *
 * The quick answer is made short here on purpose — one old chat left out —
 * and the full one a little slow, which is the shape of a busy project. Then a
 * chat is spoken in from outside the app, several times, and the old row is
 * watched every frame.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-list-holds-its-rows.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { discardFixture, makeFixtureProject } from './fixture-board';
import { writeChatSpokenAt } from './fixture-record';

const SHOTS = 'tests/results';
const LISTED_MS = 120_000;
const RUN = join(__dirname, '..', '.workbench-run-holds');
const PROJECT = join(RUN, 'project');

/** How long the full answer is held back, so the quick one lands first. */
const FULL_LAG_MS = 800;

function daysAgo(days: number): Date {
  const when = new Date();
  when.setDate(when.getDate() - days);
  when.setHours(12, 0, 0, 0);
  return when;
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
  const made = await request.post('/api/projects', { data: { name: 'workbench-holds', path, isTest: true } });
  if (made.status() === 201) return (await made.json()) as { id: string; path: string };
  const said = await made.text();
  const raced = await there();
  expect(raced, `no project at ${path}, and it could not be made: ${said}`).toBeTruthy();
  return raced!;
}

test.describe('the chat list holds its rows', () => {
  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    discardFixture(RUN);
    mkdirSync(RUN, { recursive: true });
  });
  test.describe.configure({ timeout: 300_000 });

  test('an old chat only the full answer carries never leaves the list while another chat works', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    makeFixtureProject(PROJECT, join(RUN, 'reporting'));
    const project = await projectAt(request, PROJECT);

    const working = writeChatSpokenAt({ cwd: PROJECT, sessionId: randomUUID(), at: daysAgo(0), name: 'Staging job' });
    const recent = writeChatSpokenAt({ cwd: PROJECT, sessionId: randomUUID(), at: daysAgo(4), name: 'Merge conflicts' });
    const old = writeChatSpokenAt({ cwd: PROJECT, sessionId: randomUUID(), at: daysAgo(8), name: 'Student data lookup' });
    const chats = [working, recent, old];

    let quickAnswers = 0;
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    await page.route(/\/api\/workbench\/restore\?/, async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch();
      const rows = (await response.json()) as { externalId: string | null }[];
      if (url.searchParams.get('local') === '1') {
        quickAnswers += 1;
        return route.fulfill({ response, json: rows.filter((row) => row.externalId !== old.sessionId) });
      }
      await new Promise((done) => setTimeout(done, FULL_LAG_MS));
      return route.fulfill({ response, json: rows });
    });

    const oldRow = `[data-testid="restore-row"][data-external-id="${old.sessionId}"]`;
    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: LISTED_MS });
      await page.locator(oldRow).waitFor({ timeout: LISTED_MS });

      // Watched every frame from here on, in the page, so a gap shorter than
      // any poll from the test is still seen.
      await page.evaluate((selector) => {
        const w = window as unknown as { missedFrames: number };
        w.missedFrames = 0;
        const look = (): void => {
          if (!document.querySelector(selector)) w.missedFrames += 1;
          requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }, oldRow);

      // A chat at work: its record grows on disk, the sidecar says so, and the
      // list asks again. Several times, as a running session does.
      const heardBefore = quickAnswers;
      let captured = false;
      for (let turn = 0; turn < 8; turn += 1) {
        if (turn % 2 === 0) working.saysAgain(`Turn ${turn}.`);
        else working.agentAnswers(`On it, turn ${turn}.`);
        await page.waitForTimeout(1500);
        const missed = await page.evaluate(() => (window as unknown as { missedFrames: number }).missedFrames);
        if (missed > 0 && !captured) {
          captured = true;
          await page.screenshot({ path: join(SHOTS, 'chat-list-row-gone.png') });
        }
      }
      await expect
        .poll(() => quickAnswers - heardBefore, { timeout: LISTED_MS, message: 'the list never asked again' })
        .toBeGreaterThanOrEqual(3);
      await page.waitForTimeout(FULL_LAG_MS * 2);

      await page.screenshot({ path: join(SHOTS, 'chat-list-rows-held.png') });
      const missed = await page.evaluate(() => (window as unknown as { missedFrames: number }).missedFrames);
      expect(missed, 'the old chat left the list while another chat worked').toBe(0);
      await expect(page.locator(oldRow)).toBeVisible();
    } finally {
      for (const chat of chats) chat.remove();
      await request.delete(`/api/projects/${project.id}`);
    }
  });
});
