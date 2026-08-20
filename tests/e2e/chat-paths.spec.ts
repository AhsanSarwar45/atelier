import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Files named in a chat, opened from where they are written (bw-khe.13).
 *
 * Both sides of this are answered in the browser rather than by the machine
 * running the test. Disk is answered here, so the same chat can be made to
 * prove "this is a file" and "this is not" without depending on what happens to
 * exist on the runner; and the opener is caught here, so a passing test never
 * launches a program on somebody's desktop.
 *
 * Needs an instance with at least one chat that has run commands in it. Pick the
 * project with BEADS_E2E_PROJECT, or the first the instance lists.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3027 BEADS_E2E_BACKEND=http://127.0.0.1:3028 \
 *      npx playwright test tests/e2e/chat-paths.spec.ts
 */

/** Opening a chat's past is a file read plus a wake; this is the whole way in. */
const WAY_IN_MS = 120_000;

async function projectId(request: APIRequestContext): Promise<string> {
  if (process.env.BEADS_E2E_PROJECT) return process.env.BEADS_E2E_PROJECT;
  const api = process.env.BEADS_E2E_BACKEND ?? '';
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as { id: string }[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return projects[0]!.id;
}

/** What was asked to be opened, in the order it was asked. */
interface Opened {
  path: string;
  target: string;
  line?: number;
}

/** Disk's answers and the opener, both given by the test. */
interface StandIn {
  /** Every open the app asked for, in order. */
  opened: Opened[];
  /** How many addresses the app went and asked disk about. */
  asked(): number;
}

/**
 * Disk answered in the browser, and the opener caught.
 *
 * `yes` decides what is real: with it, every address-shaped thing in the chat
 * is a file; without it, none of them is. The same chat under both is the whole
 * proof that a chip follows disk and not shape.
 */
async function standIn(page: Page, yes: boolean): Promise<StandIn> {
  const opened: Opened[] = [];
  let asked = 0;

  await page.route('**/api/fs/exists?*', async (route) => {
    asked++;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: yes }) });
  });

  await page.route('**/api/fs/open-external', async (route) => {
    opened.push(JSON.parse(route.request().postData() ?? '{}') as Opened);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });

  return { opened, asked: () => asked };
}

async function openFirstChat(page: Page, id: string): Promise<void> {
  await page.goto(`/project?id=${id}&tab=chat`);
  await page.getByTestId('restore-row').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2000);
  await page.getByTestId('restore-row').first().getByTestId('row-name').click();
  await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
}

/** Chips anywhere in the conversation. */
const chips = (page: Page) => page.locator('[data-testid="transcript"] [data-path-mention]');

/** Wait until the answers have come back and the chips are drawn. */
async function waitForChips(page: Page): Promise<void> {
  await expect.poll(async () => chips(page).count(), { timeout: 60_000 }).toBeGreaterThan(0);
}

/** Everything open, so each command and its output is on the page. */
async function showEverything(page: Page): Promise<void> {
  const all = page.getByTestId('toggle-open-all');
  if ((await all.getAttribute('data-open-all')) !== 'true') await all.click();
}

test.describe('a file named in a chat', () => {
  // A chat never opened before is read off disk and woken, and the waits below
  // are written for that. The runner's own thirty seconds would cut them off
  // long before they were allowed to give up.
  test.describe.configure({ timeout: WAY_IN_MS });

  test('is a chip, and opens the file it points at', async ({ page, request }) => {
    const id = await projectId(request);
    const { opened } = await standIn(page, true);
    await openFirstChat(page, id);
    await waitForChips(page);

    const chip = chips(page).first();
    const absolute = await chip.getAttribute('data-path-mention');
    expect(absolute, 'a chip carries no address to open').toBeTruthy();
    // Resolved against the folder that chat ran in — a chip written `src/a.ts`
    // must still open a real address, not the words.
    expect(
      absolute!.startsWith('/') || /^[A-Za-z]:[\\/]/.test(absolute!),
      `a chip carries "${absolute}", which is not an address on disk`,
    ).toBe(true);
    expect((await chip.textContent())?.length, 'a chip drew nothing').toBeGreaterThan(0);

    await chip.click();
    await expect.poll(() => opened.length, { timeout: 15_000 }).toBe(1);
    expect(opened[0]!.path, 'the chip opened something other than what it points at').toBe(absolute);
    expect(opened[0]!.target, 'a plain click must open the reader’s own default program').toBe('finder');
  });

  test('is a chip inside a command, on the row’s own line and in the command behind it', async ({
    page,
    request,
  }) => {
    const id = await projectId(request);
    await standIn(page, true);
    await openFirstChat(page, id);
    await page.getByTestId('tool-row').first().waitFor({ timeout: 60_000 });

    // The collapsed line: what the reader sees before clicking anything, and
    // where a command's folder is written — the manager's own case (bw-khe.13).
    await expect
      .poll(
        async () => page.locator('[data-testid="tool-toggle"] [data-path-mention]').count(),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    await showEverything(page);

    // And inside the command itself, where it has already been coloured.
    await expect
      .poll(async () => page.locator('[data-testid="tool-input"] [data-path-mention]').count(), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0);
  });

  test('opening it does not open the row it sits on', async ({ page, request }) => {
    const id = await projectId(request);
    const { opened } = await standIn(page, true);
    await openFirstChat(page, id);
    await page.getByTestId('tool-row').first().waitFor({ timeout: 60_000 });
    await expect
      .poll(
        async () => page.locator('[data-testid="tool-toggle"] [data-path-mention]').count(),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    const row = page
      .locator('[data-testid="tool-row"]')
      .filter({ has: page.locator('[data-testid="tool-toggle"] [data-path-mention]') })
      .first();
    const before = await row.getAttribute('data-open');

    await row.locator('[data-testid="tool-toggle"] [data-path-mention]').first().click();
    await expect.poll(() => opened.length, { timeout: 15_000 }).toBe(1);
    expect(
      await row.getAttribute('data-open'),
      'clicking a file opened the row instead of the file',
    ).toBe(before);
  });

  test('a name that is no file on disk stays plain words', async ({ page, request }) => {
    const id = await projectId(request);
    const { asked } = await standIn(page, false);
    await openFirstChat(page, id);
    await showEverything(page);
    await page.waitForTimeout(5000);

    // The same chat that chips above. That it went and asked is what makes the
    // silence mean something: the address-shaped words were found and put to
    // disk, and disk said no, so they were left as words.
    expect(asked(), 'nothing in this chat was even shaped like an address').toBeGreaterThan(0);
    expect(await chips(page).count(), 'a name that is not a file was drawn as one').toBe(0);
  });

  test('a written line number is a jump to that line', async ({ page, request }) => {
    const id = await projectId(request);
    const { opened } = await standIn(page, true);
    await page.goto(`/project?id=${id}&tab=chat`);
    await page.getByTestId('restore-row').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2000);

    // Not every chat quotes a line, so the chats are walked until one does
    // rather than the first deciding it for all of them.
    const rows = page.locator('[data-testid="restore-row"]');
    const toTry = Math.min(await rows.count(), 5);
    const withLine = page.locator('[data-testid="transcript"] [data-path-mention][data-path-line]').first();

    let found = false;
    for (let i = 0; i < toTry && !found; i++) {
      await rows.nth(i).getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });
      await showEverything(page);
      // The answers come back over the wire, so the chips arrive after the words.
      found = await withLine
        .waitFor({ state: 'attached', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
    }
    test.skip(!found, `no chat among the first ${toTry} quotes a line number`);

    const line = Number(await withLine.getAttribute('data-path-line'));
    await withLine.click({ modifiers: ['Alt'] });
    await expect.poll(() => opened.length, { timeout: 15_000 }).toBe(1);
    expect(opened[0]!.target, 'only an editor can be told a line').toBe('vscode');
    expect(opened[0]!.line, `asked for line ${opened[0]!.line} instead of ${line}`).toBe(line);
  });
});
