import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The address is where you are: the chat you opened, the card you opened, and
 * what Back means.
 *
 * Needs an instance with chats in it — the preview reading the owner's own
 * board is enough (`PORT=3017 npm run dev:live`, then
 * `BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3008`).
 *
 * Nothing here may wake an agent: opening a chat is a read, and the run asserts
 * it by watching what the browser posts. Every case therefore picks a SLEEPING
 * chat — the one case where waking used to happen.
 */

/** Reading a chat's past is a file read of a whole conversation. */
const WAY_IN_MS = 120_000;

interface Project {
  id: string;
  path: string;
}

interface RestoreRow {
  sessionId: string | null;
  externalId: string | null;
  title: string | null;
  state: string;
  beads: string[];
}

function backend(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

/** The row's own key, as the screen writes it on the row. */
function keyOf(row: RestoreRow): string {
  return row.sessionId ?? `ext:${row.externalId}`;
}

/** A chat this app has run before and is not running now. */
function asleep(rows: RestoreRow[]): RestoreRow[] {
  return rows.filter((r) => r.sessionId !== null && r.state === 'dormant');
}

/** The first project the instance lists that has sleeping chats to open. */
async function withChats(request: APIRequestContext): Promise<{ project: Project; rows: RestoreRow[] }> {
  const api = backend();
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as Project[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  const wanted = process.env.BEADS_E2E_PROJECT;
  for (const project of wanted ? projects.filter((p) => p.id === wanted) : projects) {
    const q = new URLSearchParams({ project: project.id, path: project.path });
    const rows = (await (await request.get(`${api}/api/workbench/restore?${q}`)).json()) as RestoreRow[];
    if (asleep(rows).length >= 2) return { project, rows };
  }
  throw new Error('no project on this instance has two sleeping chats to open');
}

async function openChatTab(page: Page, project: Project): Promise<void> {
  // Waiting for the LIST, not merely for a row: the rows of chats already
  // running are drawn from the live stream at once, while the list itself is a
  // fetch that reads every conversation the kit knows about and lands seconds
  // later. A case that starts as soon as one row exists is reading the wrong
  // list (bw-1u1.15).
  const listed = page.waitForResponse(
    (r) => r.url().includes('/api/workbench/restore') && r.ok(),
    { timeout: 120_000 },
  );
  await page.goto(`/project?id=${project.id}&tab=chat`);
  await listed;
  await page.getByTestId('restore-row').first().waitFor({ timeout: 60_000 });
}

/** The chat drawn right now, and how much of it. */
async function drawn(page: Page): Promise<{ sessionId: string | null; messages: number }> {
  return page.evaluate(() => ({
    sessionId: document.querySelector('[data-testid="chat-tab"]')?.getAttribute('data-session-id') ?? null,
    messages: document.querySelectorAll('[data-testid="assistant-message"],[data-testid="user-message"]').length,
  }));
}

/**
 * Brings a row onto the page.
 *
 * The list draws a screenful and grows as its foot is scrolled to, so on a board
 * with hundreds of chats a row the sidecar returned is often not in the document
 * at all — and waiting for it to scroll into view then waits forever (bw-1u1.15).
 */
async function reveal(page: Page, row: RestoreRow): Promise<boolean> {
  const at = page.locator(`[data-testid="restore-row"][data-row-key="${keyOf(row)}"]`);
  const more = page.getByTestId('chat-list-more');
  // Kept waiting when there is nothing to grow yet: the list is fetched after
  // the screen is drawn, so for the first moment the only rows are the chats
  // already running and there is no foot to scroll to at all.
  for (let round = 0; round < 120; round++) {
    if (await at.count()) return true;
    if (await more.count()) await more.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
  }
  return (await at.count()) > 0;
}

/** Opens one named row and waits until its own words are on the screen. */
async function enter(page: Page, row: RestoreRow): Promise<string> {
  const at = page.locator(`[data-testid="restore-row"][data-row-key="${keyOf(row)}"]`);
  expect(await reveal(page, row), 'the list never drew the row this case is about').toBe(true);
  await at.scrollIntoViewIfNeeded();
  await at.getByTestId('row-name').click();
  await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
  // Waiting for THIS chat, not merely for a chat: the one just left is still
  // drawn for as long as the click takes, so anything less reads it instead.
  if (row.sessionId) {
    await expect.poll(async () => (await drawn(page)).sessionId, { timeout: WAY_IN_MS }).toBe(row.sessionId);
  }
  await expect.poll(async () => (await drawn(page)).messages, { timeout: WAY_IN_MS }).toBeGreaterThan(0);
  const id = (await drawn(page)).sessionId;
  expect(id, 'the chat drew nothing it could be identified by').toBeTruthy();
  return id!;
}

/** Every command the browser sent while `work` ran. */
async function commandsDuring(page: Page, work: () => Promise<void>): Promise<string[]> {
  const sent: string[] = [];
  const watch = (request: { url(): string; method(): string; postData(): string | null }) => {
    if (request.method() !== 'POST' || !request.url().includes('/api/workbench/command')) return;
    try {
      sent.push((JSON.parse(request.postData() ?? '{}') as { type?: string }).type ?? '?');
    } catch {
      sent.push('?');
    }
  };
  page.on('request', watch);
  try {
    await work();
  } finally {
    page.off('request', watch);
  }
  return sent;
}

test.describe('the address says where you are', () => {
  // Opening a chat reads a whole conversation off the disk; the default 30s is
  // the harness's, not this screen's.
  test.describe.configure({ timeout: 300_000 });

  test('the chat you open is in the address, and opening it starts nothing', async ({ page, request }) => {
    const { project, rows } = await withChats(request);
    await openChatTab(page, project);

    const sleeping = asleep(rows)[0]!;
    let opened = '';
    const sent = await commandsDuring(page, async () => {
      opened = await enter(page, sleeping);
    });

    expect(opened, 'a sleeping chat opened under a different id').toBe(sleeping.sessionId);
    expect(new URL(page.url()).searchParams.get('chat'), 'the address does not name the open chat').toBe(opened);
    expect(
      sent.filter((t) => t === 'session.resume' || t === 'session.start'),
      `opening a sleeping chat sent ${sent.join(', ') || 'nothing'}`,
    ).toEqual([]);
  });

  test('a chat begun in a terminal opens for reading, and starts nothing', async ({ page, request }) => {
    const { project, rows } = await withChats(request);
    await openChatTab(page, project);

    const terminal = rows.find((r) => r.sessionId === null && r.externalId !== null);
    test.skip(!terminal, 'this instance has no chat begun outside the app');

    const sent = await commandsDuring(page, async () => {
      await enter(page, terminal!);
    });

    // It is given an id of ours on the way in — that is what the address carries.
    const drawnId = (await drawn(page)).sessionId;
    expect(new URL(page.url()).searchParams.get('chat')).toBe(drawnId);
    expect(sent, 'opening a terminal chat did more than open it').toEqual(['session.open']);
  });

  test('Back returns to the chat that was open before', async ({ page, request }) => {
    const { project, rows } = await withChats(request);
    await openChatTab(page, project);

    const [one, two] = asleep(rows);
    const first = await enter(page, one!);
    const second = await enter(page, two!);
    expect(second, 'the second row opened the same chat as the first').not.toBe(first);

    await page.goBack();
    await expect.poll(async () => (await drawn(page)).sessionId, { timeout: WAY_IN_MS }).toBe(first);
    expect(new URL(page.url()).searchParams.get('chat')).toBe(first);
  });

  test('the address opens the same chat in a fresh tab', async ({ page, request, context }) => {
    const { project, rows } = await withChats(request);
    await openChatTab(page, project);
    const opened = await enter(page, asleep(rows)[0]!);
    const shared = page.url();

    const other = await context.newPage();
    await other.goto(shared);
    await other.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
    await expect.poll(async () => (await drawn(other)).sessionId, { timeout: WAY_IN_MS }).toBe(opened);
    await other.close();
  });

  test('a ticket on the chat opens the card over the chat, and Back closes it', async ({ page, request }) => {
    const { project, rows } = await withChats(request);
    const worked = rows.find((r) => r.sessionId !== null && r.beads.length > 0);
    expect(worked, 'no chat on this instance names a card').toBeTruthy();
    await openChatTab(page, project);

    const opened = await enter(page, worked!);
    await page.getByTestId('bead-chip').first().waitFor({ timeout: 60_000 });
    // The line re-crowds when the chat's own account of its cards arrives, so a
    // chip read before that is a chip that has since moved into the +N. Wait for
    // the row to stop changing, then take one.
    const names = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="bead-chip"]')].map((c) => c.getAttribute('data-bead-id')).join(),
      );
    await expect
      .poll(
        async () => {
          const before = await names();
          await new Promise((r) => setTimeout(r, 750));
          return (await names()) === before;
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    const card = await page.getByTestId('bead-chip').first().getAttribute('data-bead-id');
    await page.locator(`[data-testid="bead-chip"][data-bead-id="${card}"]`).click();

    await page.getByTestId('bead-detail').waitFor({ timeout: 60_000 });
    const address = new URL(page.url());
    expect(address.searchParams.get('card'), 'the open card is not in the address').toBe(card);
    expect(address.searchParams.get('tab'), 'the card threw the reader off the chat').toBe('chat');
    expect(address.searchParams.get('chat'), 'the chat was lost when the card opened').toBe(opened);
    expect(await page.getByTestId('chat-tab').isVisible(), 'the chat is no longer drawn behind the card').toBe(true);

    await page.goBack();
    await expect(page.getByTestId('bead-detail')).toBeHidden({ timeout: 60_000 });
    await expect.poll(async () => (await drawn(page)).sessionId, { timeout: WAY_IN_MS }).toBe(opened);
  });

  test('closing a card leaves no dead Back press behind it', async ({ page, request }) => {
    const { project, rows } = await withChats(request);
    const worked = rows.find((r) => r.sessionId !== null && r.beads.length > 0);
    expect(worked, 'no chat on this instance names a card').toBeTruthy();
    await openChatTab(page, project);
    await enter(page, worked!);

    const depth = () => page.evaluate(() => history.length);
    const before = await depth();

    await page.getByTestId('bead-chip').first().waitFor({ timeout: 60_000 });
    await page.getByTestId('bead-chip').first().click();
    await page.getByTestId('bead-detail').waitFor({ timeout: 60_000 });
    expect(await depth(), 'opening a card added no history entry').toBe(before + 1);

    // Closed by hand, not by Back: the entry it added has to be stepped off, or
    // the next Back press goes to an address identical to this one and nothing
    // happens (bw-m8o.10).
    await page.getByTestId('bead-detail-close').click();
    await expect(page.getByTestId('bead-detail')).toBeHidden({ timeout: 60_000 });
    await expect.poll(async () => new URL(page.url()).searchParams.get('card'), { timeout: 30_000 }).toBeNull();
    const closed = page.url();

    await page.goBack();
    await page.waitForTimeout(1500);
    expect(page.url(), 'Back after closing a card did nothing — its entry is still there').not.toBe(closed);
  });

  test('the board and the card panel read one list, not two', async ({ page, request }) => {
    const { project, rows } = await withChats(request);
    const card = rows.flatMap((r) => r.beads)[0];
    test.skip(!card, 'no chat on this instance names a card');

    const asked: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/beads?')) asked.push(r.url());
    });

    await page.goto(`/project?id=${project.id}&tab=board`);
    await page.getByTestId('board-scroll').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(4000);
    const beforeOpen = asked.length;

    // Opened without leaving the page, the way a click on a card opens it.
    await page.evaluate((id) => {
      const q = new URLSearchParams(window.location.search);
      q.set('card', id);
      window.history.pushState({}, '', `${window.location.pathname}?${q}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, card!);
    await page.getByTestId('bead-detail').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(4000);

    // Opening a card must not start a second reading of the board: one list,
    // held by the screen and shared with the panel (bw-m8o.11).
    expect(
      asked.length - beforeOpen,
      `the card list was fetched ${asked.length - beforeOpen} more times when a card opened`,
    ).toBe(0);
  });

  test('the tab you left is in the history', async ({ page, request }) => {
    const { project, rows } = await withChats(request);
    await openChatTab(page, project);
    const opened = await enter(page, asleep(rows)[0]!);

    await page.getByTestId('tab-board').click();
    await page.getByTestId('board-scroll').waitFor({ timeout: 60_000 });

    await page.goBack();
    await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
    await expect.poll(async () => (await drawn(page)).sessionId, { timeout: WAY_IN_MS }).toBe(opened);
  });
});
