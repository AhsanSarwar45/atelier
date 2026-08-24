import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';

/**
 * How many times one screen asks for the same thing.
 *
 * A board is built from many parts and several of them want the same answer as
 * it opens, so the reader used to wait for the same second-long read more than
 * once for one screen. This holds that to one ask per thing, and holds a board
 * that was just read to answering without reading it again (bw-uiyz.9).
 *
 * Run it against a BUILT instance, never `next dev`: the development server
 * runs every effect twice on purpose, so a screen that asks once there asks
 * twice, and the numbers are not the product's.
 *
 *   npm run build
 *   BEADS_E2E_URL=http://127.0.0.1:3018 \
 *   BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
 *     npx playwright test tests/board-reads.spec.ts
 */

/** How many times one board load may ask for the cards. */
const BEADS_ASKS = 1;
/** A board that was read a moment ago answers again this fast. */
const AGAIN_MS = 50;

/** A screen drawn from hundreds of cards can take a while to settle. */
const WAY_IN_MS = 120_000;

interface Project {
  id: string;
  name: string;
  path: string;
}

function backend(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

/** The checkout this run is measuring, however many copies of it are cut. */
function ownCheckout(): string {
  const git = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  return dirname(git);
}

async function boardUnderTest(request: APIRequestContext): Promise<Project> {
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

/** Every request the page made while `work` ran. */
async function asksDuring(page: Page, work: () => Promise<void>): Promise<string[]> {
  const asked: string[] = [];
  const watch = (request: Request) => asked.push(request.url());
  page.on('requestfinished', watch);
  page.on('requestfailed', watch);
  try {
    await work();
  } finally {
    page.off('requestfinished', watch);
    page.off('requestfailed', watch);
  }
  return asked;
}

function cards(page: Page) {
  return page.locator('[aria-label^="Select bead"], [aria-label^="Select epic"]');
}

test.describe('the board is read once, not once per part that asks', () => {
  test.describe.configure({ mode: 'default', timeout: 300_000 });

  test('one board load asks for the cards once', async ({ page, request }) => {
    const project = await boardUnderTest(request);

    // Straight to the board: what the list of projects asks for on the way is
    // its own question, and its own card.
    const asked = await asksDuring(page, async () => {
      await page.goto(`/project?id=${project.id}`);
      await cards(page).first().waitFor({ timeout: WAY_IN_MS });
      // A part that asks late is still a part that asks.
      await page.waitForTimeout(2_000);
    });

    const board = encodeURIComponent(project.path);
    const mine = (u: string) => u.includes(board);
    // A read of only what changed since a moment is not a read of the board:
    // it costs almost nothing and it is how the screen keeps up to date.
    const whole = asked.filter((u) => /\/api\/beads\?/.test(u) && mine(u) && !u.includes('updated_after'));
    // eslint-disable-next-line no-console
    console.log(`one board load: ${whole.length} asks for the cards`);

    expect(whole.length, `${whole.length} asks for the same cards`).toBeLessThanOrEqual(BEADS_ASKS);
  });

  test('a board just read answers again without reading it', async ({ request }) => {
    const project = await boardUnderTest(request);
    const url = `${backend()}/api/beads?path=${encodeURIComponent(project.path)}`;

    // Whatever the server last read of this board may be old enough to have
    // been dropped, so the first ask is the one that pays for the read.
    const firstAt = Date.now();
    const first = await request.get(url, { timeout: WAY_IN_MS });
    const firstMs = Date.now() - firstAt;
    expect(first.ok(), 'the board could not be read').toBe(true);

    const againAt = Date.now();
    const again = await request.get(url, { timeout: WAY_IN_MS });
    const againMs = Date.now() - againAt;
    expect(again.ok(), 'the board could not be read again').toBe(true);

    const wasCards = ((await first.json()) as { beads?: unknown[] }).beads ?? [];
    const isCards = ((await again.json()) as { beads?: unknown[] }).beads ?? [];
    // eslint-disable-next-line no-console
    console.log(`board of ${wasCards.length} cards: read in ${firstMs}ms, read again in ${againMs}ms`);

    expect(isCards.length, 'the second read gave a different board').toBe(wasCards.length);
    expect(againMs, `reading the same board again took ${againMs}ms`).toBeLessThan(AGAIN_MS);
  });

  test('a card written to the board shows on the next read', async ({ request }) => {
    const project = await boardUnderTest(request);
    const url = `${backend()}/api/beads?path=${encodeURIComponent(project.path)}`;

    const before = ((await (await request.get(url, { timeout: WAY_IN_MS })).json()) as {
      beads?: { id: string }[];
    }).beads ?? [];

    const title = `read-sharing check ${process.pid}-${before.length}`;
    const made = await request.post(`${backend()}/api/beads/create`, {
      data: { path: project.path, title, issue_type: 'task', priority: 4 },
      timeout: WAY_IN_MS,
    });
    expect(made.ok(), 'the card could not be written').toBe(true);

    const after = ((await (await request.get(url, { timeout: WAY_IN_MS })).json()) as {
      beads?: { id: string; title?: string }[];
    }).beads ?? [];
    const found = after.find((b) => b.title === title);
    expect(found, 'a card written to the board did not show on the next read').toBeTruthy();

    // Leave the board as it was found.
    await request.post(`${backend()}/api/beads/update`, {
      data: { path: project.path, id: found!.id, status: 'closed' },
      timeout: WAY_IN_MS,
    });
  });
});
