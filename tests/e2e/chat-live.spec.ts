import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  aChatSomebodyElseIsIn,
  aProject,
  backend,
  claimConversation,
  command,
  openChatTab,
  type Project,
} from './fixture-held';

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
 * The harness that makes a chat start and stop being worked in — the marker
 * directory, the record on disk — is shared with the other runs that need one
 * and lives in `fixture-held.ts`, which says what BEADS_E2E_MARKERS must be set
 * to and why it may never be the tool's own directory.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
 *      BEADS_E2E_MARKERS=/some/scratch/claude/sessions \
 *      npx playwright test tests/e2e/chat-live.spec.ts
 */

/**
 * What the rail draws before the reader scrolls — the number that turned "low
 * down" into "absent" (src/workbench/chat-sidebar.tsx, SCREENFUL).
 */
const SCREENFUL = 40;

interface RestoreRow {
  sessionId: string | null;
  externalId: string | null;
  title: string | null;
  state: string;
  lastActiveAt: string;
  runningElsewhere?: boolean;
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

/**
 * What a row says about its chat.
 *
 * Three separate things, which is the correction this run stands on: the mark
 * that moves while something is happening, the word beside it, and the badge
 * that says somebody else is in there. The badge used to BE the word — a green
 * "working" pill drawn from the marker directory alone — so a terminal left at
 * an empty prompt overnight read as working (bw-96is).
 */
interface RowMark {
  key: string;
  running: boolean;
  working: boolean;
  word: string | null;
  external: boolean;
}

/**
 * Every row the rail has drawn, in the order it drew them.
 *
 * The reading is spelled out inside the browser rather than shared with
 * {@link rowNow}: what runs in there is a function of its own, and a helper
 * from out here is not in scope when it runs.
 */
async function drawnRows(page: Page): Promise<RowMark[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="restore-row"]')).map((el) => {
      const chip = el.querySelector('[data-testid="row-pill"]');
      return {
        key: el.getAttribute('data-row-key') ?? '',
        running: el.getAttribute('data-running') === 'yes',
        working: chip?.getAttribute('data-working') === 'yes',
        word: chip?.getAttribute('data-word') ?? null,
        external: el.querySelector('[data-testid="chat-external"]') !== null,
      };
    }),
  );
}

/** What the rail says about one row right now. */
async function rowNow(page: Page, key: string): Promise<RowMark | null> {
  return page.evaluate((wanted) => {
    const el = document.querySelector(`[data-testid="restore-row"][data-row-key="${wanted}"]`);
    if (!el) return null;
    const chip = el.querySelector('[data-testid="row-pill"]');
    return {
      key: el.getAttribute('data-row-key') ?? '',
      running: el.getAttribute('data-running') === 'yes',
      working: chip?.getAttribute('data-working') === 'yes',
      word: chip?.getAttribute('data-word') ?? null,
      external: el.querySelector('[data-testid="chat-external"]') !== null,
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

    // The mark itself, on those rows and on no others. Held, not working:
    // a terminal sitting at an empty prompt holds its conversation all night
    // and is doing nothing, so what every one of these rows must carry is the
    // badge — and what none of the others may carry is the badge (bw-96is).
    for (const row of drawn) {
      expect(row.external, `${row.key} is held by another program and does not say so`).toBe(row.running);
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
    expect((await rowNow(page, key))!.external, 'the row was already held by somebody').toBe(false);

    // Held AND working: the marker carries the word a terminal writes into its
    // own while it owes an answer, so the row has to draw both — the moving
    // mark and, beside it, the badge (bw-96is).
    const release = claimConversation(idle!.externalId!, { status: 'busy' });
    try {
      await expect
        .poll(async () => (await rowNow(page, key))?.external ?? null, { timeout: 20_000 })
        .toBe(true);
      const marked = (await rowNow(page, key))!;
      expect(marked.working, 'a chat whose holder says it is busy drew no moving mark').toBe(true);
      expect(marked.word, 'the moving mark came with no word').toBeTruthy();
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
    expect((await rowNow(page, key))!.external, 'the badge outlived the program it stood for').toBe(false);
    expect(fetches - settled, 'the rail asked for the list again instead of listening').toBe(0);
  });
});

test.describe('the door into a conversation somebody else is in', () => {
  /**
   * The lock the reader sees is drawn by the browser, from a stream that can
   * drop — and it did drop on the manager's machine, after which a chat the
   * server itself called running opened with an ordinary writing box. So the
   * refusal is asked of the server directly here, the way a browser with a dead
   * stream asks it: no screen, no stream, just the message (bw-dmxj.12).
   */
  test('the server refuses a message into it, whatever the screen believes', async ({ request }) => {
    const project = await aProject(request);
    const chat = aChatSomebodyElseIsIn(project.path, 'Rework the restore list');
    const release = claimConversation(chat.id);

    let sessionId = '';
    try {
      const opened = await command(request, {
        type: 'session.open',
        externalId: chat.id,
        brand: 'claude',
        projectId: project.id,
        projectPath: project.path,
      });
      expect(opened.ok, `opening it for reading failed: ${opened.body}`).toBe(true);
      sessionId = opened.said.id!;

      // Reading it is allowed; typing into it is not.
      const sent = await command(request, { type: 'prompt.send', sessionId, text: 'do the thing' });
      expect(sent.ok, 'the sidecar accepted a message into somebody else’s conversation').toBe(false);
      expect(sent.said.error ?? sent.body).toContain('Another program is working in this chat');

      // The other door into attaching, asked directly.
      const resumed = await command(request, {
        type: 'session.resume',
        sessionId,
        externalId: chat.id,
        brand: 'claude',
        projectId: project.id,
        projectPath: project.path,
      });
      expect(resumed.ok, 'the sidecar attached a driver to somebody else’s conversation').toBe(false);
      expect(resumed.said.error ?? resumed.body).toContain('Another program is working in this chat');
    } finally {
      release();
    }

    // That program has stopped, so the chat is the reader's to take up.
    const facts = await request.get(`${backend()}/api/workbench/session/${sessionId}`);
    expect(((await facts.json()) as { runningElsewhere?: boolean }).runningElsewhere).toBe(false);

    // And the door is a door, not a wall: the same attach that was refused a
    // moment ago is allowed now. Asked of attaching rather than of sending,
    // because a message that went through would spend a real turn — attaching
    // is the thing the refusal guards, and it is the thing checked.
    const again = await command(request, {
      type: 'session.resume',
      sessionId,
      externalId: chat.id,
      brand: 'claude',
      projectId: project.id,
      projectPath: project.path,
    });
    expect(again.ok, `the chat stayed shut after the other program stopped: ${again.body}`).toBe(true);
    await command(request, { type: 'session.stop', sessionId });
    chat.forget();
  });
});

test.describe('a chat another program is running', () => {
  test('follows a chat another program runs', async ({ page, request }) => {
    // Longer than the default: this case waits for the list, then for a chat to
    // be opened and read, then twice for something said in another program to
    // arrive. Each wait is short; the sum of them is not.
    test.setTimeout(180_000);
    const project = await aProject(request);
    const opening = 'Look at the routing on the chat tab';
    const chat = aChatSomebodyElseIsIn(project.path, opening);
    const release = claimConversation(chat.id);

    try {
      // The box has to refuse from the first frame it draws, so it may not wait
      // on the chat's own facts: that answer is a board query away, most of a
      // second, and a second is long enough to type into a box that looks
      // ordinary. Blocked outright here — whatever locks the box, it is not
      // that (bw-dmxj.8).
      await page.route('**/api/workbench/session/*', (route) => route.abort());
      await openChatTab(page, project);

      // It is being worked in, so it is marked and at the top of the rail.
      const row = page.locator(`[data-testid="restore-row"][data-row-key="ext:${chat.id}"]`);
      await expect(row, 'the chat being worked in was not offered').toBeVisible({ timeout: 30_000 });
      // The name is the way in; the row around it is not a button.
      await row.getByTestId('row-name').click();

      // Opening it is opening THAT conversation: what was already said is here.
      await expect(page.getByTestId('transcript').getByText(opening)).toBeVisible({ timeout: 30_000 });

      // And there is no box at all: one line saying who is in there stands
      // where it was. A box drawn in full and refusing every keystroke is a
      // door with a lock on it where there is no door, and typing into it
      // would wake a second agent on the same record (bw-96is).
      await expect(page.getByTestId('held-elsewhere')).toBeVisible();
      await expect(page.getByTestId('composer')).toHaveCount(0);
      await expect(page.getByTestId('send-button')).toHaveCount(0);

      // And the top of the chat says what its row in the list says. "Asleep" is
      // true of our own agent and false of what is on the screen, which is a
      // conversation being worked in as the reader watches (bw-dmxj.10).
      await expect(page.getByTestId('session-state')).toHaveAttribute('data-state', 'held');
      await expect(page.getByTestId('chat-external')).toBeVisible();

      // The whole of it: something said over there turns up here, with nobody
      // reloading anything.
      const said = 'the suite came back green, 282 passed';
      chat.says(said);
      await expect(page.getByTestId('transcript').getByText(said)).toBeVisible({ timeout: 30_000 });

      // Twice, so it is following rather than having read once more on open.
      const then = 'and the build is on the shelf';
      chat.says(then);
      await expect(page.getByTestId('transcript').getByText(then)).toBeVisible({ timeout: 30_000 });
    } finally {
      release();
    }

    // That program has stopped: the chat is the reader's to take up, and the
    // box is back by itself because the stream it went away on says so.
    await expect(page.getByTestId('composer')).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId('held-elsewhere')).toHaveCount(0);
    await expect(page.getByTestId('chat-external')).toHaveCount(0);
    await expect(page.getByTestId('session-state')).not.toHaveAttribute('data-state', 'held');
    chat.forget();
  });

  /**
   * What the other program was in the middle of when the reader walked away.
   *
   * A record being written to right now ends in commands whose answers have not
   * landed, and those are held back rather than drawn finished and empty. Only
   * the follower ever draws them — so when the reader leaves, the follower is
   * torn down and that tail belongs to nobody. The chat had already been written
   * down as read in full, so opening it again read nothing and drew nothing, and
   * what the other program did while nobody was watching was gone for good
   * (bw-dmxj.14).
   */
  test('a command left mid-air is drawn when the chat is opened again', async ({ page, request }) => {
    test.setTimeout(180_000);
    const project = await aProject(request);
    const opening = 'Run the suite and tell me what broke';
    const chat = aChatSomebodyElseIsIn(project.path, opening);
    const release = claimConversation(chat.id);
    // Started over there, with nothing back yet.
    const call = chat.runs('Bash', { command: 'npm test' });
    const row = `[data-testid="restore-row"][data-external-id="${chat.id}"]`;

    try {
      await openChatTab(page, project);
      await expect(page.locator(row), 'the chat being worked in was not offered').toBeVisible({ timeout: 30_000 });
      await page.locator(row).getByTestId('row-name').click();
      await expect(page.getByTestId('transcript').getByText(opening)).toBeVisible({ timeout: 30_000 });
      // Held back, because drawing it now would draw it finished and empty.
      await expect(page.locator('[data-testid="tool-row"]')).toHaveCount(0);

      // He looks at something else, and what was in the air lands while nobody
      // is watching that chat.
      await page.goto(`/project?id=${project.id}&tab=board`);
      await expect(page.getByTestId('transcript')).toHaveCount(0, { timeout: 30_000 });
    } finally {
      release();
    }
    chat.printed(call, '313 passed, 0 failed');
    chat.says('Nothing broke.');

    // Opened again, with that program gone: the chat holds everything it did.
    await openChatTab(page, project);
    await page.locator(row).getByTestId('row-name').click();
    await expect(
      page.locator('[data-testid="tool-row"][data-tool-name="Bash"]'),
      'what the other program did while nobody watched was dropped',
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('transcript').getByText('Nothing broke.')).toBeVisible({ timeout: 30_000 });
    chat.forget();
  });
});
