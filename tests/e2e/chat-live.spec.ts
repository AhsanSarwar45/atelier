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
 * Run: BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
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
});
