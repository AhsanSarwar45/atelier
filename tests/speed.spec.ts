import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';

/**
 * How long the app takes to appear.
 *
 * Two numbers, one per screen the manager waits on: the list of projects and
 * a chat. Every case prints its number and goes red when it is over budget, so a change that
 * makes a screen slower is caught here rather than in his afternoon.
 *
 * Run it against a BUILT instance, never `next dev`: the development server
 * compiles a route the first time it is asked for and ships the screen
 * unminified, which is a different product from the one he runs.
 *
 *   npm run build                                    # the static screen
 *   BEADS_E2E_URL=http://127.0.0.1:3018 \
 *   BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
 *     npx playwright test tests/speed.spec.ts
 *
 * The budgets are the ones the job was opened against (bw-uiyz).
 */

/** The list of projects is on screen this long after the click. */
const LIST_DRAWN_MS = 800;
/** A chat with a long history is on screen this long after the click. */
const CHAT_DRAWN_MS = 700;
/** Data the list of projects downloads to draw a handful of names. */
const LIST_BYTES = 300 * 1024;
/**
 * The app's own code, which every screen downloads before it can draw.
 *
 * Held at what it costs today so it cannot quietly grow; bringing it down is
 * its own job, because it is the same weight on every screen.
 */
const APP_BYTES = 1_100 * 1024;
/** A long screen can take a while to settle the first time. */
const WAY_IN_MS = 120_000;
/** How many chats are opened before the longest of them is held to the budget. */
const CHATS_TRIED = 4;

interface Project {
  id: string;
  name: string;
  path: string;
}

interface RestoreRow {
  sessionId: string | null;
  externalId: string | null;
  title: string | null;
  state: string;
}

/** What one request cost, as the browser saw it. */
interface Ask {
  url: string;
  ms: number;
  bytes: number;
}

function backend(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

/** Every request the page made while `work` ran, with what each one cost. */
async function asksDuring(page: Page, work: () => Promise<void>): Promise<Ask[]> {
  const pending: Promise<Ask>[] = [];
  const watch = (request: Request) => {
    pending.push(
      (async () => {
        const timing = request.timing();
        const sizes = await request.sizes().catch(() => ({ responseBodySize: 0 }));
        return {
          url: request.url(),
          ms: Math.max(0, timing.responseEnd),
          bytes: sizes.responseBodySize ?? 0,
        };
      })(),
    );
  };
  page.on('requestfinished', watch);
  try {
    await work();
  } finally {
    page.off('requestfinished', watch);
  }
  return Promise.all(pending);
}

/** The checkout this run is measuring, however many copies of it are cut. */
function ownCheckout(): string {
  const git = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  return dirname(git);
}

/** The project this run measures: this checkout's own, or whichever is named. */
async function projectUnderTest(request: APIRequestContext): Promise<Project> {
  const api = backend();
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as Project[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  const wanted = process.env.BEADS_E2E_PROJECT;
  const here = ownCheckout();
  const project =
    (wanted ? projects.find((p) => p.id === wanted || p.name === wanted) : undefined) ??
    projects.find((p) => p.path === here) ??
    projects[0];
  expect(project, 'the instance does not list the project this run is measuring').toBeTruthy();
  return project;
}

/**
 * How much was said in a chat, as the transcript it was read from.
 *
 * The list gives no size, and the slow chat is the long one — so the run reads
 * the file the app itself replays and opens the fattest, rather than whichever
 * happens to sit at the top of the list.
 */
function saidBytes(externalId: string | null): number {
  if (!externalId) return 0;
  const root = join(homedir(), '.claude', 'projects');
  let held: string[];
  try {
    held = readdirSync(root);
  } catch {
    return 0;
  }
  for (const dir of held) {
    try {
      return statSync(join(root, dir, `${externalId}.jsonl`)).size;
    } catch {
      // The transcript is kept under some other folder.
    }
  }
  return 0;
}

/**
 * Waits until the screen has stopped changing, and says how long that took.
 *
 * Drawn is not the first row: a screen that paints a little and then spends
 * five seconds fetching the rest is what this whole job is about. The number is
 * the moment the count of what is on screen stopped moving.
 */
async function settle(page: Page, count: () => Promise<number>): Promise<number> {
  const started = Date.now();
  let seen = -1;
  let steadyAt = 0;
  const deadline = started + WAY_IN_MS;
  while (Date.now() < deadline) {
    const now = await count();
    if (now > 0 && now === seen) {
      if (!steadyAt) steadyAt = Date.now();
      // Two quiet looks in a row: nothing else is on its way.
      else if (Date.now() - steadyAt >= 250) return steadyAt - started;
    } else {
      seen = now;
      steadyAt = 0;
    }
    await page.waitForTimeout(50);
  }
  throw new Error('the screen never stopped changing');
}

test.describe('how long the app takes to appear', () => {
  // One screen at a time, whatever the rest of the suite does: two of these
  // running at once fight over the same server and time each other's queue
  // rather than the screen. A screen that is over budget is still measured
  // rather than abandoned — the number is what the case is for.
  test.describe.configure({ mode: 'default', timeout: 300_000 });

  test('project list is drawn from counts, not from every project', async ({ page }) => {
    let drawn = 0;
    const asked = await asksDuring(page, async () => {
      await page.goto('/');
      drawn = await settle(page, () => page.locator('[aria-label^="View "]').count());
    });

    // The app's own code and the data it asks for are two different
    // weights with two different cures, and adding them together hides which
    // one moved.
    const code = asked.filter((a) => a.url.includes('/_next/'));
    const data = asked.filter((a) => a.url.includes('/api/'));
    const codeBytes = code.reduce((total, a) => total + a.bytes, 0);
    const dataBytes = data.reduce((total, a) => total + a.bytes, 0);
    // eslint-disable-next-line no-console
    console.log(
      `project list: ${Math.round(dataBytes / 1024)}KB of data over ${data.length} asks, ` +
        `${Math.round(codeBytes / 1024)}KB of app code, drawn in ${drawn}ms`,
    );

    expect(dataBytes, `${Math.round(dataBytes / 1024)}KB of data to draw a list of names`).toBeLessThan(
      LIST_BYTES,
    );
    expect(codeBytes, `${Math.round(codeBytes / 1024)}KB of app code before anything is drawn`).toBeLessThan(
      APP_BYTES,
    );
    expect(drawn, `the list took ${drawn}ms`).toBeLessThan(LIST_DRAWN_MS);
  });

  test('chat opens at once, however much was said in it', async ({ page, request }) => {
    const project = await projectUnderTest(request);
    const api = backend();
    const q = new URLSearchParams({ project: project.id, path: project.path });
    const rows = (await (await request.get(`${api}/api/workbench/restore?${q}`)).json()) as RestoreRow[];
    const asleep = rows
      .filter((r) => r.sessionId !== null && r.state === 'dormant')
      .map((row) => ({ row, said: saidBytes(row.externalId) }))
      .sort((a, b) => b.said - a.said);
    expect(asleep.length, 'the instance has no chat to open').toBeGreaterThan(0);

    const listed = page.waitForResponse((r) => r.url().includes('/api/workbench/restore') && r.ok(), {
      timeout: WAY_IN_MS,
    });
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await listed;
    await page.getByTestId('restore-row').first().waitFor({ timeout: WAY_IN_MS });

    // The budget is about the chat that is slow, which is the one with the most
    // in it — opening whichever happens to be first measures a chat nobody waits
    // on. So several are opened and the longest is the one held to the number.
    const said = page.locator('[data-testid="assistant-message"],[data-testid="user-message"]');
    const opened: { messages: number; ms: number; kb: number }[] = [];
    for (const { row, said: bytes } of asleep.slice(0, CHATS_TRIED)) {
      const at = page.locator(`[data-testid="restore-row"][data-row-key="${row.sessionId}"]`);
      if (!(await at.count())) continue;
      await at.scrollIntoViewIfNeeded();
      const started = Date.now();
      await at.getByTestId('row-name').click();
      await said.first().waitFor({ timeout: WAY_IN_MS });
      const watching = Date.now();
      const ms = watching - started + (await settle(page, () => said.count()));
      opened.push({ messages: await said.count(), ms, kb: Math.round(bytes / 1024) });
      await page.goBack();
      await page.getByTestId('restore-row').first().waitFor({ timeout: WAY_IN_MS });
    }
    expect(opened.length, 'no chat in the list could be opened').toBeGreaterThan(0);

    // Held to the slowest of the four, not the longest transcript: what the app
    // redraws is its own record of the conversation, and a fat file on disk is
    // only a hint at which chats are worth trying.
    const longest = opened.reduce((worst, one) => (one.ms > worst.ms ? one : worst));
    // eslint-disable-next-line no-console
    console.log(
      `chats opened: ${opened.map((o) => `${o.kb}KB of transcript, ${o.messages} messages in ${o.ms}ms`).join('; ')}`,
    );

    expect(longest.ms, `the slowest of ${opened.length} chats took ${longest.ms}ms`).toBeLessThan(
      CHAT_DRAWN_MS,
    );
  });
});
