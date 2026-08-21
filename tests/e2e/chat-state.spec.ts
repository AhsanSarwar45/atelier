import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { aChatSomebodyElseIsIn, claimConversation, openChatTab, type Project } from './fixture-held';

/**
 * What a chat says about itself, on every screen.
 *
 * The manager, 2026-08-21: "remove this working tag. instead for chats that are
 * processing, external or our own, it must show a spinner. for chats that are
 * external, it should show a external badge that only shows on external ones.
 * and there must be a status to show if they are actually working like other
 * normal chats use these, but the external ones don't show if they are idle or
 * processing. just make sure everything about the state of chat is intuitive.
 * currently its awful."
 *
 * Three facts that were tangled into one word (bw-96is):
 *
 * - what it is doing this second — the moving mark, its own verb, its seconds;
 * - where it stands when it is doing nothing — one word, and only then;
 * - who holds it — a badge beside the first two and never in place of them.
 *
 * The old green "working" pill was written from the existence of a marker file,
 * so a terminal sitting at an empty prompt read as working all night, and a
 * chat that really was answering said nothing different.
 *
 * Needs the shared held-chat harness, which says what BEADS_E2E_MARKERS must
 * point at (`fixture-held.ts`), and a stack built from THIS worktree: what the
 * sidecar reports about a holder, and what it publishes for a chat nothing is
 * driving, are both changed here.
 *
 * Run: CLAUDE_CONFIG_DIR=/some/scratch/claude \
 *      BEADS_E2E_MARKERS=/some/scratch/claude/sessions \
 *      scripts/workbench-e2e.sh tests/e2e/chat-state.spec.ts
 *
 * It brings its own project rather than borrowing one, so it runs on a stack
 * with an empty settings DB — which is what that script starts.
 */

/** Reading a chat's past is a file read of a whole conversation. */
const WAY_IN_MS = 120_000;

/** Where this run's project lives, out of the way of Playwright's own output. */
const PROJECT_DIR = join(__dirname, '..', '.chat-state-run');

/**
 * The project every case here works in.
 *
 * Marked `isTest`, so it stays off the owner's dashboard and is swept up by the
 * teardown if a run dies before its own cleanup.
 */
async function aFixtureProject(request: APIRequestContext): Promise<Project> {
  mkdirSync(PROJECT_DIR, { recursive: true });
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as Project[];
  const found = listed.find((p) => p.path === PROJECT_DIR);
  if (found) return found;
  const made = await request.post('/api/projects', {
    data: { name: 'chat-state', path: PROJECT_DIR, isTest: true },
  });
  // The cases run side by side and all want the one project, so losing the
  // race to create it is not a failure — the winner's row is the answer.
  if (made.status() !== 201) {
    const again = (await (await request.get('/api/projects?include_test=true')).json()) as Project[];
    const other = again.find((p) => p.path === PROJECT_DIR);
    expect(other, `could not make or find the project: ${await made.text()}`).toBeTruthy();
    return other!;
  }
  return (await made.json()) as Project;
}

/** The row a conversation somebody else is in is offered on. */
function rowFor(page: Page, conversation: string) {
  return page.locator(`[data-testid="restore-row"][data-external-id="${conversation}"]`);
}

/** The number a chip is counting, or null when it is counting nothing. */
async function secondsOn(chip: ReturnType<Page['getByTestId']>): Promise<number | null> {
  const text = (await chip.textContent()) ?? '';
  const match = /(\d+)s\b/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * A project marked `isTest` is filtered out of the plain project list, which is
 * what the project page itself reads to resolve a name — so without this the
 * fixture project would be invisible to its own browser tab. Scoped to this
 * page alone: a real visitor typing the same address still sees none of them.
 */
test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
});

test.describe('a chat another program is in', () => {
  test('draws the moving mark and the badge together, and drops the mark alone when they stop', async ({
    page,
    request,
  }) => {
    // Two waits on a program somebody else runs, each one a beat of the
    // marker watch plus the stream.
    test.setTimeout(180_000);
    const project = await aFixtureProject(request);
    const opening = 'Check the numbers on the token panel';
    const chat = aChatSomebodyElseIsIn(project.path, opening);
    // A terminal in the middle of a turn: it writes `busy` into its own marker
    // with the moment it said so, which is the signal the old pill never read.
    const release = claimConversation(chat.id, { status: 'busy' });

    try {
      await openChatTab(page, project);
      const row = rowFor(page, chat.id);
      await expect(row, 'the chat being worked in was not offered').toBeVisible({ timeout: 30_000 });

      // Both, on the row: the mark that says it is working AND the badge that
      // says the work is somebody else's. The badge is the whole of what the
      // old pill said, and it said it in place of this (bw-96is).
      await expect(row.getByTestId('row-pill')).toHaveAttribute('data-working', 'yes', { timeout: 30_000 });
      await expect(row.getByTestId('chat-external')).toBeVisible();

      await row.getByTestId('row-name').click();
      await expect(page.getByTestId('transcript').getByText(opening)).toBeVisible({ timeout: 30_000 });

      // And the same two things at the top of the chat, in the same words.
      const chip = page.getByTestId('session-state-chip');
      await expect(chip).toHaveAttribute('data-working', 'yes');
      await expect(chip).toHaveAttribute('data-word', 'Working');
      await expect(page.getByTestId('session-state').getByTestId('chat-external')).toBeVisible();
      await expect(page.getByTestId('session-state')).toHaveAttribute('data-state', 'held');

      // With its seconds, counted from when that terminal said it was busy and
      // growing while the reader watches — the difference between a mark that
      // is alive and a mark that is merely drawn.
      const first = await secondsOn(chip);
      expect(first, 'the moving mark counted nothing').not.toBeNull();
      await expect
        .poll(async () => (await secondsOn(chip)) ?? -1, { timeout: 20_000 })
        .toBeGreaterThan(first!);

      // That terminal comes back to a prompt. Same marker, same conversation,
      // one word changed — so the badge stays and the mark goes, which is the
      // exact reading the old pill could not make.
      claimConversation(chat.id, { status: 'idle' });
      await expect(chip).toHaveAttribute('data-working', 'no', { timeout: 30_000 });
      await expect(chip).toHaveAttribute('data-word', 'Idle');
      expect(await secondsOn(chip), 'a chat doing nothing was still counting').toBeNull();
      await expect(page.getByTestId('session-state').getByTestId('chat-external')).toBeVisible();
    } finally {
      release();
    }

    // And when they let go of it altogether, the badge goes with them.
    await expect(page.getByTestId('session-state').getByTestId('chat-external')).toHaveCount(0, { timeout: 30_000 });
    chat.forget();
  });

  test('wears a badge no chat of ours wears', async ({ page, request }) => {
    test.setTimeout(180_000);
    const project = await aFixtureProject(request);
    const chat = aChatSomebodyElseIsIn(project.path, 'Look at the rail again');
    const release = claimConversation(chat.id, { status: 'busy' });

    try {
      await openChatTab(page, project);
      await expect(rowFor(page, chat.id)).toBeVisible({ timeout: 30_000 });
      // The rail merges the live stream into the fetched list; give that its
      // beat before counting badges off the document.
      await page.waitForTimeout(1500);

      // The badge means something by being there, which it can only do if it
      // is on the held chats and on nothing else. Counted over the whole rail
      // rather than on one row, because "only shows on external ones" is a
      // claim about every other row (bw-96is.5).
      const seen = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="restore-row"]')).map((el) => ({
          key: el.getAttribute('data-row-key') ?? '',
          held: el.getAttribute('data-running') === 'yes',
          badge: el.querySelector('[data-testid="chat-external"]') !== null,
        })),
      );
      expect(seen.length, 'the rail drew nothing').toBeGreaterThan(0);
      expect(seen.some((r) => r.held), 'no chat on the rail is held by another program').toBe(true);
      const wrong = seen.filter((r) => r.held !== r.badge);
      expect(wrong, `${wrong.length} rows disagree with themselves about who holds them`).toEqual([]);
    } finally {
      release();
    }
    chat.forget();
  });

  test('has no writing box at all, and gets an ordinary one back when they stop', async ({ page, request }) => {
    test.setTimeout(180_000);
    const project = await aFixtureProject(request);
    const opening = 'Rework the composer';
    const chat = aChatSomebodyElseIsIn(project.path, opening);
    const release = claimConversation(chat.id, { status: 'busy' });

    try {
      await openChatTab(page, project);
      await expect(rowFor(page, chat.id)).toBeVisible({ timeout: 30_000 });
      await rowFor(page, chat.id).getByTestId('row-name').click();
      await expect(page.getByTestId('transcript').getByText(opening)).toBeVisible({ timeout: 30_000 });

      // Not a box that refuses: no box. A door with a lock on it where there
      // is no door invites the reader to try the handle, and a keystroke that
      // got through would wake a SECOND agent on the same record (bw-96is.6).
      await expect(page.getByTestId('composer')).toHaveCount(0);
      await expect(page.getByTestId('send-button')).toHaveCount(0);
      await expect(page.getByTestId('composer-frame')).toHaveCount(0);

      // One line stands in its place: who is in there, and that it comes back.
      const said = page.getByTestId('held-elsewhere');
      await expect(said).toBeVisible();
      await expect(said).toContainText('terminal');
      await expect(said).toContainText('comes back when they let go');
    } finally {
      release();
    }

    // Which it does, by itself, because the stream it went away on says so.
    await expect(page.getByTestId('composer')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('composer')).toBeEnabled();
    await expect(page.getByTestId('send-button')).toHaveCount(1);
    await expect(page.getByTestId('held-elsewhere')).toHaveCount(0);
    chat.forget();
  });
});

test.describe('a chat nothing is running', () => {
  /**
   * Reached by its address, a sleeping chat says it is asleep.
   *
   * It used to say "Coming back" for as long as the app stayed open. The
   * browser marks a chat it is opening as starting, and the sidecar only ever
   * corrected that for a chat whose stored state was already dormant or ended —
   * so a chat left at any other state, which is every chat this app ran and
   * never stopped, had no event on its way to it and sat there for good
   * (bw-m8o.17, bw-96is.7).
   */
  test('reads asleep, the same word its row in the list gives it', async ({ page, request }) => {
    test.setTimeout(180_000);
    const project = await aFixtureProject(request);
    const opening = 'Tidy the rail';
    // Nobody holds this one: it is a conversation on disk and nothing more,
    // which is what every chat in the list is most of the time.
    const chat = aChatSomebodyElseIsIn(project.path, opening);

    await openChatTab(page, project);
    const row = rowFor(page, chat.id);
    await expect(row, 'the sleeping chat was not offered').toBeVisible({ timeout: 30_000 });

    // Its row says nothing at all, which is the whole of what the list has to
    // say about a chat that is asleep: most of a list is asleep, and a mark on
    // every row is a mark on none (chat-state.ts, bw-96is).
    await expect(row.getByTestId('row-pill')).toHaveCount(0);
    await expect(row.getByTestId('chat-external')).toHaveCount(0);

    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('transcript').getByText(opening)).toBeVisible({ timeout: 30_000 });
    const opened = new URL(page.url()).searchParams.get('chat');
    expect(opened, 'opening the chat did not put it in the address').toBeTruthy();

    // Reached by that address — a second tab, a bookmark, a reload — with
    // nothing driving it. The browser marks a chat it is opening as starting,
    // and what has to arrive is the correction.
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${opened}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: WAY_IN_MS });

    const chip = page.getByTestId('session-state-chip');
    await expect(chip, 'a chat nothing is running still said it was coming back').toHaveAttribute(
      'data-word',
      'Asleep',
      { timeout: 60_000 },
    );
    await expect(chip).toHaveAttribute('data-working', 'no');
    await expect(page.getByTestId('session-state')).toHaveAttribute('data-state', 'dormant');
    await expect(page.getByTestId('session-state').getByTestId('chat-external')).toHaveCount(0);

    // And the list is still saying the same thing about it.
    await expect(rowFor(page, chat.id)).toHaveAttribute('data-state', 'dormant', { timeout: 60_000 });
    await expect(rowFor(page, chat.id).getByTestId('row-pill')).toHaveCount(0);
    chat.forget();
  });
});
