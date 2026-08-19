import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A chat somebody is working in, seen from the list.
 *
 * The complaint this run stands against: with six agents working on his own
 * copy, the list marked none of them, and the one holding the card he asked
 * about sat 54th of 55 rows while the list draws 40 — so it was not merely low
 * down, it was not drawn at all (bw-dmxj).
 *
 * Needs an instance whose machine has at least one Claude chat RUNNING — a
 * terminal open in the project is enough. With nothing running there is nothing
 * to mark, and the run says so rather than passing on an empty list.
 *
 * The second case has to make a chat start and stop being worked in, which it
 * cannot do to a real one. So the stack under test runs its sidecar with
 * CLAUDE_CONFIG_DIR pointed at a COPY of the tool's own config — its
 * `sessions/*.json` markers, never the `.key` files beside them — and the run
 * is told where that copy's `sessions` directory is:
 *
 *   BEADS_E2E_MARKERS=/some/scratch/claude/sessions
 *
 * The copied markers name the same live processes, so the first case reads the
 * same truth either way. The second writes one marker of its own, naming the
 * test runner's own process, and deletes it again.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
 *      BEADS_E2E_MARKERS=/some/scratch/claude/sessions \
 *      npx playwright test tests/e2e/chat-live.spec.ts
 */

/** The list is a read of every conversation the kit knows about. */
const LISTED_MS = 120_000;

/**
 * What the rail draws before the reader scrolls — the number that turned "low
 * down" into "absent" (src/workbench/chat-sidebar.tsx, SCREENFUL).
 */
const SCREENFUL = 40;

interface Project {
  id: string;
  path: string;
}

interface RestoreRow {
  sessionId: string | null;
  externalId: string | null;
  title: string | null;
  state: string;
  lastActiveAt: string;
  runningElsewhere?: boolean;
}

function backend(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

/** The row's own key, as the screen writes it on the row. */
function keyOf(row: RestoreRow): string {
  return row.sessionId ?? `ext:${row.externalId}`;
}

/** The first project the instance lists that has a chat being worked in. */
async function withAWorkingChat(request: APIRequestContext): Promise<{ project: Project; rows: RestoreRow[] }> {
  const api = backend();
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as Project[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  const wanted = process.env.BEADS_E2E_PROJECT;
  for (const project of wanted ? projects.filter((p) => p.id === wanted) : projects) {
    const q = new URLSearchParams({ project: project.id, path: project.path });
    const rows = (await (await request.get(`${api}/api/workbench/restore?${q}`)).json()) as RestoreRow[];
    if (rows.some((r) => r.runningElsewhere)) return { project, rows };
  }
  throw new Error('no chat is running on this machine: open one in a terminal, then run this again');
}

async function openChatTab(page: Page, project: Project): Promise<void> {
  // Waiting for the LIST, not merely for a row: chats already running are drawn
  // from the live stream at once, while the list itself lands seconds later.
  const listed = page.waitForResponse((r) => r.url().includes('/api/workbench/restore') && r.ok(), {
    timeout: LISTED_MS,
  });
  await page.goto(`/project?id=${project.id}&tab=chat`);
  await listed;
  await page.getByTestId('restore-row').first().waitFor({ timeout: 60_000 });
}

/** Every row the rail has drawn, in the order it drew them. */
async function drawnRows(page: Page): Promise<{ key: string; running: boolean; pill: string | null }[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="restore-row"]')).map((el) => ({
      key: el.getAttribute('data-row-key') ?? '',
      running: el.getAttribute('data-running') === 'yes',
      pill: el.querySelector('[data-testid="row-pill"]')?.getAttribute('data-pill') ?? null,
    })),
  );
}

/**
 * The directory the sidecar under test reads its markers from — a copy, so a
 * case may add one and take it away.
 *
 * Never the real one: writing a marker there puts a chat that does not exist in
 * front of the tool itself.
 */
function markerDir(): string {
  const dir = process.env.BEADS_E2E_MARKERS;
  if (!dir) throw new Error('set BEADS_E2E_MARKERS to the sessions directory the stack under test reads');
  const real = join(homedir(), '.claude', 'sessions');
  if (resolve(dir) === real) throw new Error(`BEADS_E2E_MARKERS is the tool's own directory: ${real}`);
  return resolve(dir);
}

/**
 * The process start time the kernel holds for us — field 22 of our own stat
 * line, which is what tells a live marker from one whose process number has
 * been handed on. Split on the LAST parenthesis: field 2 is the executable's
 * name and the kernel does not escape it.
 */
function ourProcStart(): string {
  try {
    const line = readFileSync('/proc/self/stat', 'utf8');
    return line.slice(line.lastIndexOf(')') + 1).trim().split(/\s+/)[19] ?? '0';
  } catch {
    return '0';
  }
}

/** Says a live process is holding this conversation, until it is taken away. */
function claimConversation(conversation: string): () => void {
  const file = join(markerDir(), `${process.pid}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      pid: process.pid,
      sessionId: conversation,
      cwd: process.cwd(),
      startedAt: Date.now(),
      procStart: ourProcStart(),
      kind: 'interactive',
      entrypoint: 'cli',
    }),
  );
  return () => rmSync(file, { force: true });
}

/** What the rail says about one row right now. */
async function rowNow(page: Page, key: string): Promise<{ running: boolean; pill: string | null } | null> {
  return page.evaluate((wanted) => {
    const el = document.querySelector(`[data-testid="restore-row"][data-row-key="${wanted}"]`);
    if (!el) return null;
    return {
      running: el.getAttribute('data-running') === 'yes',
      pill: el.querySelector('[data-testid="row-pill"]')?.getAttribute('data-pill') ?? null,
    };
  }, key);
}

test.describe('a chat that is working', () => {
  test('marks what is working, and puts it at the top', async ({ page, request }) => {
    const { project, rows } = await withAWorkingChat(request);
    const working = rows.filter((r) => r.runningElsewhere).map(keyOf);

    await openChatTab(page, project);
    // The rail merges the live stream into the fetched list; give that its beat
    // before reading the order off the document.
    await page.waitForTimeout(1500);
    const drawn = await drawnRows(page);

    expect(drawn.length, 'the rail drew nothing').toBeGreaterThan(0);
    expect(drawn.length, 'the rail drew past its own screenful').toBeLessThanOrEqual(SCREENFUL);

    // Every chat being worked in is on the screen at all — the whole of the
    // original complaint, before anything about marks or order.
    const onScreen = new Set(drawn.map((r) => r.key));
    const missing = working.filter((k) => !onScreen.has(k));
    expect(missing, `${missing.length} of ${working.length} working chats were not drawn`).toEqual([]);

    // And they are the top of the list, in one run, with nothing idle above.
    const firstIdle = drawn.findIndex((r) => !r.running);
    const lastWorking = drawn.map((r) => r.running).lastIndexOf(true);
    expect(lastWorking, 'no row on the screen says it is working').toBeGreaterThanOrEqual(0);
    expect(lastWorking, 'a chat nobody is working in was drawn above one somebody is').toBeLessThan(
      firstIdle < 0 ? drawn.length : firstIdle,
    );

    // The mark itself, on those rows and on no others.
    for (const row of drawn) {
      if (row.running) expect(row.pill, `${row.key} is working and says ${row.pill ?? 'nothing'}`).toBe('working');
      else expect(row.pill, `${row.key} is not working and says it is`).not.toBe('working');
    }
  });

  test('mark arrives and leaves, with the list never asked again', async ({ page, request }) => {
    const { project, rows } = await withAWorkingChat(request);
    // A chat nobody is working in, drawn in the first screenful so it is in the
    // document to watch, and known to the tool by its own id — which is what
    // the stream names.
    const idle = rows.slice(0, SCREENFUL).filter((r) => !r.runningElsewhere && r.externalId)[0];
    expect(idle, 'no idle chat in the first screenful to watch').toBeTruthy();
    const key = keyOf(idle!);

    // Once the tab has settled the list is never asked for again, so anything
    // the rail changes after that, it changed on what the stream told it. The
    // count before that is not the claim — a dev server mounts twice.
    let fetches = 0;
    page.on('response', (r) => {
      if (r.url().includes('/api/workbench/restore')) fetches += 1;
    });

    await openChatTab(page, project);
    await page.waitForTimeout(1500);
    const settled = fetches;
    expect(await rowNow(page, key), 'the row to watch was not drawn').toBeTruthy();
    expect((await rowNow(page, key))!.running, 'the row was already marked as working').toBe(false);

    const release = claimConversation(idle!.externalId!);
    try {
      await expect
        .poll(async () => (await rowNow(page, key))?.pill ?? null, { timeout: 20_000 })
        .toBe('working');
      // And it climbed while it was at it: above every chat nobody is working
      // in, without anybody asking for the list again. Not to the very top —
      // the chats already running have today's dates and it does not.
      const order = await drawnRows(page);
      const mine = order.findIndex((r) => r.key === key);
      const firstIdle = order.findIndex((r) => !r.running);
      expect(mine, 'the row that started working left the screen').toBeGreaterThanOrEqual(0);
      expect(mine, 'the row that started working stayed below chats nobody is working in').toBeLessThan(
        firstIdle < 0 ? order.length : firstIdle,
      );
    } finally {
      release();
    }

    await expect
      .poll(async () => (await rowNow(page, key))?.running ?? null, { timeout: 20_000 })
      .toBe(false);
    expect(fetches - settled, 'the rail asked for the list again instead of listening').toBe(0);
  });
});
