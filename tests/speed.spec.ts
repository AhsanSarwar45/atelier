import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';

/**
 * How long the app takes to appear.
 *
 * Four numbers, one per screen the manager waits on: the board, the list of
 * projects, a chat, and what the board asks anyone else while it draws. Every
 * case prints its number and goes red when it is over budget, so a change that
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

/** The board is on screen this long after the click. */
const BOARD_DRAWN_MS = 1_500;
/** The list of projects is on screen this long after the click. */
const LIST_DRAWN_MS = 800;
/** A chat with a long history is on screen this long after the click. */
const CHAT_DRAWN_MS = 700;
/** Board data the list of projects downloads to draw a handful of names. */
const LIST_BYTES = 300 * 1024;
/**
 * The app's own code, which every screen downloads before it can draw.
 *
 * Held at what it costs today so it cannot quietly grow; bringing it down is
 * its own job, because it is the same weight on every screen and nothing to do
 * with how a board is read.
 */
const APP_BYTES = 1_100 * 1024;
/** How many pieces of screen a board of hundreds of cards may hold at rest. */
const BOARD_PIECES = 1_500;
/**
 * How many questions about pull requests a board may ask: none.
 *
 * The manager does not use pull requests, so nothing on a card has an answer
 * worth waiting for — and every one of these questions was a call across the
 * internet before it could be answered at all.
 */
const PR_ASKS = 0;

/** A screen drawn from hundreds of cards can take a while to settle the first time. */
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

interface Bead {
  id: string;
  title: string | null;
  status: string;
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

/**
 * The board this run measures: this project's own, or whichever is named.
 *
 * Not simply the largest one the instance holds — how much a board costs
 * depends on what its cards carry, and picking by size lands on a board that
 * asks nothing and reports a screen that is fast when the one beside it is not.
 */
async function boardUnderTest(request: APIRequestContext): Promise<{ project: Project; beads: Bead[] }> {
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
  const answer = await request.get(`${api}/api/beads?path=${encodeURIComponent(project.path)}`, {
    timeout: WAY_IN_MS,
  });
  expect(answer.ok(), `the board at ${project.path} could not be read`).toBe(true);
  const body = (await answer.json()) as { beads?: Bead[] };
  return { project, beads: body.beads ?? [] };
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

/** Cards drawn on the board right now. */
function cards(page: Page) {
  return page.locator('[aria-label^="Select bead"], [aria-label^="Select epic"]');
}

/**
 * Waits until the screen has stopped changing, and says how long that took.
 *
 * Drawn is not the first card: a board that paints one column and then spends
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

/** Pieces of screen the document holds. */
function pieces(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('*').length);
}

test.describe('how long the app takes to appear', () => {
  // One screen at a time, whatever the rest of the suite does: four of these
  // running at once fight over the same server and time each other's queue
  // rather than the screen. A screen that is over budget is still measured
  // rather than abandoned — the number is what the case is for.
  test.describe.configure({ mode: 'default', timeout: 300_000 });

  test('board asks about no pull requests, and calls nothing outside', async ({ page, request }) => {
    const { project, beads } = await boardUnderTest(request);

    const asked = await asksDuring(page, async () => {
      await page.goto('/');
      const opener = page.locator(`[aria-label="View ${project.name} project"]`).first();
      await opener.waitFor({ timeout: WAY_IN_MS });
      await opener.click();
      await cards(page).first().waitFor({ timeout: WAY_IN_MS });
      await settle(page, () => cards(page).count());
      // A board that only asks after it is drawn is still a board that asks.
      await page.waitForTimeout(2_000);
    });

    const github = asked.filter((a) => a.url.includes('github.com'));
    const pr = asked.filter((a) => a.url.includes('/api/git/pr-status') || a.url.includes('/api/git/prs'));
    const slowest = pr.reduce((worst, a) => Math.max(worst, a.ms), 0);
    // eslint-disable-next-line no-console
    console.log(
      `board of ${beads.length} cards: ${pr.length} pull-request questions, slowest ${Math.round(slowest)}ms, ${github.length} calls to github`,
    );

    expect(github, 'the screen called github itself').toHaveLength(0);
    expect(pr.length, `${pr.length} pull-request questions for one board`).toBeLessThanOrEqual(PR_ASKS);
  });

  test('project list is drawn from counts, not from every board', async ({ page }) => {
    let drawn = 0;
    const asked = await asksDuring(page, async () => {
      await page.goto('/');
      drawn = await settle(page, () => page.locator('[aria-label^="View "]').count());
    });

    // The app's own code and the board data it asks for are two different
    // weights with two different cures, and adding them together hides which
    // one moved.
    const code = asked.filter((a) => a.url.includes('/_next/'));
    const data = asked.filter((a) => a.url.includes('/api/'));
    const codeBytes = code.reduce((total, a) => total + a.bytes, 0);
    const dataBytes = data.reduce((total, a) => total + a.bytes, 0);
    // eslint-disable-next-line no-console
    console.log(
      `project list: ${Math.round(dataBytes / 1024)}KB of board data over ${data.length} asks, ` +
        `${Math.round(codeBytes / 1024)}KB of app code, drawn in ${drawn}ms`,
    );

    expect(dataBytes, `${Math.round(dataBytes / 1024)}KB of board data to draw a list of names`).toBeLessThan(
      LIST_BYTES,
    );
    expect(codeBytes, `${Math.round(codeBytes / 1024)}KB of app code before anything is drawn`).toBeLessThan(
      APP_BYTES,
    );
    expect(drawn, `the list took ${drawn}ms`).toBeLessThan(LIST_DRAWN_MS);
  });

  test('board draws what is on screen, not every card there is', async ({ page, request }) => {
    const { project, beads } = await boardUnderTest(request);

    await page.goto('/');
    const opener = page.locator(`[aria-label="View ${project.name} project"]`).first();
    await opener.waitFor({ timeout: WAY_IN_MS });
    const started = Date.now();
    await opener.click();
    await cards(page).first().waitFor({ timeout: WAY_IN_MS });
    const watching = Date.now();
    const drawn = watching - started + (await settle(page, () => cards(page).count()));
    const held = await pieces(page);
    // eslint-disable-next-line no-console
    console.log(`board of ${beads.length} cards: drawn in ${drawn}ms, holding ${held} pieces of screen`);

    expect(drawn, `the board took ${drawn}ms`).toBeLessThan(BOARD_DRAWN_MS);
    expect(held, `the board holds ${held} pieces of screen`).toBeLessThan(BOARD_PIECES);

    // A board that draws only what is on screen must still find what is not.
    const buried = beads.filter((b) => (b.title ?? '').length > 25).at(-1);
    expect(buried, 'the board has no card with a title long enough to search for').toBeTruthy();
    await page.getByPlaceholder(/search/i).first().fill(buried!.title!.slice(0, 40));
    await expect(
      page.locator(`[aria-label*="${buried!.title!.slice(0, 30).replace(/"/g, '')}"]`).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('chat opens at once, however much was said in it', async ({ page, request }) => {
    const { project } = await boardUnderTest(request);
    const api = backend();
    const q = new URLSearchParams({ project: project.id, path: project.path });
    const rows = (await (await request.get(`${api}/api/workbench/restore?${q}`)).json()) as RestoreRow[];
    const asleep = rows
      .filter((r) => r.sessionId !== null && (r.state === 'dormant' || r.state === 'ended'))
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
