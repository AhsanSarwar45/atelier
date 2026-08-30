import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from '@playwright/test';

import { writeChatWithHelper } from './fixture-record';

/**
 * The plan chip letting go of a figure nobody is saying any more.
 *
 * The chip is the one number on the line that reads exactly the same whether it
 * was fetched a moment ago or an hour ago, so a page that has stopped being
 * told it goes on painting a percentage that has stopped being an answer. There
 * are two ways the telling stops, and the chip has to answer both by drawing
 * nothing at all rather than a stale number.
 *
 * The first is the one people actually meet. The sidecar is its own process
 * behind the app's server and the server retries it quietly, so when it goes
 * down — or its own poller stops — the browser's socket stays open and the page
 * is simply never told the figure again. Nothing closes, nothing errors, and
 * the chip used to sit on that dead reading for as long as the app stayed up
 * (bw-643q.4). The second is the older one: the connection itself goes
 * (bw-643q.1).
 *
 * Both are proved on a real socket rather than a stubbed one, because what is
 * being claimed is about a connection: a mock WebSocket cannot be found still
 * open, and "still open" is the whole of the first case. So the page's own
 * connection is let through to the running sidecar and only the frames carrying
 * the figure are held back on the way past — the same connection goes on
 * carrying everything else, and the proxy counts the readings it refused, which
 * is what says the sidecar was still speaking while the page went quiet.
 *
 * The ninety seconds the figure stands for are jumped rather than sat through
 * (`page.clock`), so the case costs the run seconds where it would have cost it
 * a minute and a half of watching a chip not move.
 *
 * Run: BEADS_E2E_LIVE_PROVIDERS=1 scripts/workbench-e2e.sh tests/e2e/the-plan-figure-goes-quiet.spec.ts
 *
 * It needs the live-providers flag: the chip draws nothing at all for an
 * account with no plan allowance to report, and the allowance is only readable
 * with the real credentials the harness copies in.
 */

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** The screen this is read at, with both columns open. */
const SCREEN = { width: 1440, height: 900 };

/** Opening a project and finding a chat on disk. */
const OPENS_MS = 60_000;

/**
 * How long the sidecar can take to say the figure. It reads on a beat of thirty
 * seconds and a cold read starts a kit process, so two beats is the wait.
 */
const A_BEAT_MS = 75_000;

/** How long the chip stands without being told the figure again (live.ts). */
const FIGURE_STANDS = '01:40';

/**
 * How long the chip may take to go once the connection has gone.
 *
 * Seconds, not the ninety the figure otherwise stands for: a chip that goes
 * inside this window cannot have been taken by the watchdog, so the drop is the
 * only thing that can have taken it.
 */
const AT_ONCE_MS = 5_000;

/** A folder of this run's own for each case, so neither can answer for the other. */
const QUIET = join(__dirname, '..', '.workbench-figure-quiet');
const CUT = join(__dirname, '..', '.workbench-figure-cut');

/**
 * A project of this run's own, marked as a test project so it stays off the
 * owner's dashboard and is swept up rather than living on his machine.
 */
async function fixtureProject(
  request: APIRequestContext,
  name: string,
  path: string,
): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const found = listed.find((p) => p.path === path);
  if (found) return found;
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/**
 * Whether one frame off the wire is the sidecar saying the figure.
 *
 * Everything the window watches comes down one connection with each frame
 * tagged by the feed it came from, and the helper's own frame is carried whole
 * inside it as text (live-wire.ts, server/src/routes/live.rs) — so the figure
 * is two layers down, and both are read rather than the text being searched.
 */
function saysTheFigure(message: string | Buffer): boolean {
  try {
    const carried = JSON.parse(String(message)) as { tag?: string; data?: string };
    if (carried.tag !== 'workbench') return false;
    return (JSON.parse(carried.data ?? '') as { kind?: string }).kind === 'usage';
  } catch {
    // A frame this case cannot read is not a figure, and not worth the run.
    return false;
  }
}

/** What the case can do to the page's own connection, and what it has seen on it. */
interface Tap {
  /** Sockets the page has opened. It re-opens when the reader moves, never on its own. */
  opened: number;
  /** Readings the sidecar sent that this proxy refused to pass on. */
  withheld: number;
  /** Whether the figure is being kept from the page. */
  holding: boolean;
  /** Take the connection away, and leave every later one hearing nothing. */
  cut: () => Promise<void>;
}

/**
 * Sits between the page and the running sidecar on the page's own connection.
 *
 * Everything is forwarded both ways until a case asks for the figure to be
 * held; then the readings are counted and dropped and the rest goes through, so
 * the socket the page is holding is a live one throughout. Installed before the
 * page is opened, because the connection is opened with the first screen.
 */
async function tapTheStream(page: Page): Promise<Tap> {
  const tap: Tap = { opened: 0, withheld: 0, holding: false, cut: async () => {} };
  // Held in a box rather than a bare variable: the route runs later than the
  // line that would read it, and only the box survives that.
  const held: { socket: WebSocketRoute | null } = { socket: null };
  let severed = false;

  await page.routeWebSocket(/\/api\/live/, (ws) => {
    tap.opened += 1;
    // Once the stream has been taken away it stays away: a page that re-opened
    // onto a live sidecar would be told the figure again, and the case would be
    // proving the reconnection rather than the drop.
    if (severed) return;
    held.socket = ws;
    const sidecar = ws.connectToServer();
    sidecar.onMessage((message) => {
      if (tap.holding && saysTheFigure(message)) {
        tap.withheld += 1;
        return;
      }
      ws.send(message);
    });
  });

  tap.cut = async () => {
    severed = true;
    await held.socket?.close();
  };
  return tap;
}

/** Opens a chat found on disk, with nothing driving it, and waits for the line. */
async function openTheChat(page: Page, project: { id: string }, sessionId: string): Promise<void> {
  await page.goto(`/project?id=${project.id}&tab=chat`);
  const row = page.locator(`[data-testid="restore-row"][data-external-id="${sessionId}"]`);
  await row.waitFor({ timeout: OPENS_MS });
  await row.getByTestId('row-name').click();
  await page.getByTestId('chat-tab').waitFor({ timeout: OPENS_MS });
}

/** The chip, standing with a figure on it. Returns what it is reading. */
async function theFigureOnScreen(page: Page): Promise<string> {
  const chip = page.getByTestId('plan-chip');
  await chip.waitFor({ timeout: A_BEAT_MS });
  const said = await chip.getAttribute('data-percent');
  expect(
    said,
    'the chip is up but carrying no percentage, so its going again would say nothing',
  ).toMatch(/^\d+(\.\d+)?$/);
  return said!;
}

test.describe('the plan figure goes quiet', () => {
  test.use({ viewport: SCREEN });
  test.describe.configure({ timeout: 420_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    for (const dir of [QUIET, CUT]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
  });

  /**
   * A test project is left off the plain list, which is the list the project
   * page itself reads — so this page asks for them too, and a real visitor
   * typing the same address still sees none (as workbench.spec.ts does).
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('lets the figure go when the readings stop arriving down a live socket', async ({ page, request }) => {
    const tap = await tapTheStream(page);
    // Installed before the first screen, so the page loads with time running
    // normally and only jumps when this case says so.
    await page.clock.install();

    const project = await fixtureProject(request, 'figure-goes-quiet', QUIET);
    const written = writeChatWithHelper({ cwd: QUIET, sessionId: randomUUID(), card: 'bw-643q' });

    try {
      await openTheChat(page, project, written.sessionId);
      const said = await theFigureOnScreen(page);
      await page.screenshot({ path: `${SHOTS}/plan-figure-standing.png` });

      // How many sockets it took to get here. It moves as the reader moves —
      // asking for a chat asks the connection for a new shape — so it is read
      // now and must not move again: a page that re-opened is a page whose
      // socket dropped, which is the other case entirely.
      const openedByNow = tap.opened;

      // From here the page hears everything except the figure.
      tap.holding = true;

      // The sidecar goes on speaking down this same socket, and this proxy goes
      // on catching readings on it. That is the whole of the fault: nothing has
      // closed, nothing has errored, and the page is simply not being told.
      await expect
        .poll(() => tap.withheld, {
          timeout: A_BEAT_MS,
          message: 'the sidecar said nothing more, so nothing here was held back from the page',
        })
        .toBeGreaterThan(0);
      expect(
        tap.opened,
        'the page opened another socket, so what follows would say nothing about a live one',
      ).toBe(openedByNow);
      await expect(page.getByTestId('plan-chip')).toBeVisible();

      // Now the time passes, and nothing else changes.
      await page.clock.fastForward(FIGURE_STANDS);

      await expect(
        page.getByTestId('plan-chip'),
        `the chip is still reading ${said}% after ${FIGURE_STANDS} with nobody saying it`,
      ).toHaveCount(0, { timeout: 15_000 });
      expect(tap.opened, 'the socket dropped after all, so this proves the older case twice').toBe(
        openedByNow,
      );
      await page.screenshot({ path: `${SHOTS}/plan-figure-gone-quiet.png` });

      // And the connection really was live the whole way through: let the
      // readings past again and the next one lands on the same socket.
      tap.holding = false;
      await expect(page.getByTestId('plan-chip')).toHaveCount(1, { timeout: A_BEAT_MS });
      expect(tap.opened, 'the figure came back down a socket the page had to re-open').toBe(openedByNow);
    } finally {
      written.remove();
      await request.delete(`/api/projects/${project.id}`);
      rmSync(QUIET, { recursive: true, force: true });
    }
  });

  test('lets the figure go when the connection goes', async ({ page, request }) => {
    const tap = await tapTheStream(page);
    const project = await fixtureProject(request, 'figure-cut-off', CUT);
    const written = writeChatWithHelper({ cwd: CUT, sessionId: randomUUID(), card: 'bw-643q' });

    try {
      await openTheChat(page, project, written.sessionId);
      const said = await theFigureOnScreen(page);
      await page.screenshot({ path: `${SHOTS}/plan-figure-standing-cut.png` });

      await tap.cut();

      await expect(
        page.getByTestId('plan-chip'),
        `the chip is still reading ${said}% with nothing left to say it`,
      ).toHaveCount(0, { timeout: AT_ONCE_MS });
      await page.screenshot({ path: `${SHOTS}/plan-figure-gone-cut.png` });
    } finally {
      written.remove();
      await request.delete(`/api/projects/${project.id}`);
      rmSync(CUT, { recursive: true, force: true });
    }
  });
});
