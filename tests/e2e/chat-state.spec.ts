import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { aChatSomebodyElseIsIn, claimConversation, openChatTab, saysItIsDoing, type Project } from './fixture-held';

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

  test('keeps its badge whole on the row the reader has open, and apart from the mark beside it', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const project = await aFixtureProject(request);
    const chat = aChatSomebodyElseIsIn(project.path, 'Read the badge on the open row');
    const release = claimConversation(chat.id, { status: 'busy' });

    try {
      await openChatTab(page, project);
      const row = rowFor(page, chat.id);
      await expect(row.getByTestId('row-pill')).toHaveAttribute('data-working', 'yes', { timeout: 30_000 });
      const badge = row.getByTestId('chat-external');
      await expect(badge).toBeVisible();

      // What it measures is the drawn box, not a class name: the badge was
      // asked for a look the badge component has no rule for, fell back to a
      // flat grey with a transparent border, and on the selected row — whose
      // background is that same grey — there was nothing left of it to see
      // (bw-96is.10).
      const alone = await badge.boundingBox();
      expect(alone, 'the badge drew no box at all').not.toBeNull();
      expect(alone!.width, 'the badge drew nothing wide').toBeGreaterThan(0);
      expect(alone!.height, 'the badge drew nothing tall').toBeGreaterThan(0);

      await row.getByTestId('row-name').click();
      await expect(page.getByTestId('transcript')).toBeVisible({ timeout: 30_000 });
      await expect(row, 'the row left the rail when it was opened').toBeVisible();
      const opened = await badge.boundingBox();
      expect(opened, 'the badge vanished on the row the reader has open').not.toBeNull();
      expect(opened!.width, 'the badge changed width when its row was selected').toBeCloseTo(alone!.width, 0);
      expect(opened!.height, 'the badge changed height when its row was selected').toBeCloseTo(alone!.height, 0);

      // A box the right size is not a box anybody can see. The badge went on
      // vanishing into the open row long after this case was written, because
      // all this case asked of its border was that it be SOME colour — and the
      // colour it was, was the open row's own (bw-96is.19). What the eye does
      // is compare the badge against what is behind it, so that is what is
      // compared here: a shape survives by having a fill of its own or an edge
      // of its own, and the open row is the case where it has neither.
      const against = await page.evaluate((id: string) => {
        const row_ = document.querySelector(`[data-testid="restore-row"][data-external-id="${id}"]`);
        const seen = row_?.querySelector('[data-testid="chat-external"]');
        if (!row_ || !seen) return null;
        const a = getComputedStyle(seen);
        return {
          fill: a.backgroundColor,
          edge: a.borderTopColor,
          edgeWidth: parseFloat(a.borderTopWidth),
          behind: getComputedStyle(row_).backgroundColor,
        };
      }, chat.id);
      expect(against, 'the open row drew no badge').not.toBeNull();
      const gone = /rgba\(0, 0, 0, 0\)|transparent/;
      const stands =
        (against!.fill !== against!.behind && !gone.test(against!.fill)) ||
        (against!.edgeWidth > 0 && !gone.test(against!.edge) && against!.edge !== against!.behind);
      expect(
        stands,
        `the badge has neither a fill nor an edge of its own on the open row: fill ${against!.fill}, edge ${against!.edge}, row ${against!.behind}`,
      ).toBe(true);

      // And it is not the mark: a reader who does not stop to read the words
      // still has the colour and the corners to go on.
      //
      // Waited for rather than read straight off: the pane's own line is drawn
      // from the app-wide stream, which arrives a beat after the transcript, so
      // reading the pixels the moment the transcript appears failed under a
      // loaded machine and passed on a quiet one — a check that is a coin toss
      // proves nothing either way (bw-96is.17).
      const line = page.getByTestId('session-state');
      await expect(line.getByTestId('chat-external')).toBeVisible({ timeout: 30_000 });
      await expect(line.getByTestId('session-state-chip')).toBeVisible({ timeout: 30_000 });
      const apart = await page.evaluate(() => {
        const seen = document.querySelector('[data-testid="session-state"]');
        const one = seen?.querySelector('[data-testid="chat-external"]');
        const two = seen?.querySelector('[data-testid="session-state-chip"]');
        if (!one || !two) return null;
        const a = getComputedStyle(one);
        const b = getComputedStyle(two);
        return {
          colour: a.backgroundColor !== b.backgroundColor,
          corners: a.borderTopLeftRadius !== b.borderTopLeftRadius,
          // Its own two: nothing behind it, and a border that is really there.
          fill: a.backgroundColor,
          edge: a.borderTopColor,
          edgeWidth: parseFloat(a.borderTopWidth),
        };
      });
      expect(apart, 'the open chat drew no badge beside its mark').not.toBeNull();
      expect(apart!.colour, 'the badge is the same colour as the mark beside it').toBe(true);
      expect(apart!.corners, 'the badge is the same shape as the mark beside it').toBe(true);

      // And quieter than it: an outline where the mark has a fill, so the eye
      // lands on what the chat is doing before who is holding it. A filled
      // badge in its own colour beat the mark it is a footnote to, and a
      // transparent BORDER is how it vanished into the selected row in the
      // first place — so both halves are held here (bw-96is.10).
      expect(apart!.fill, 'the badge is filled, so it shouts over the mark beside it').toMatch(
        /rgba\(0, 0, 0, 0\)|transparent/,
      );
      expect(apart!.edgeWidth, 'the badge drew no border to hold its shape').toBeGreaterThan(0);
      expect(apart!.edge, 'the badge border is invisible, which is how it vanished before').not.toMatch(
        /rgba\(0, 0, 0, 0\)|transparent/,
      );
    } finally {
      release();
    }
    chat.forget();
  });

  test('draws the whole of the word on its mark, tails and all', async ({ page, request }) => {
    test.setTimeout(180_000);
    const project = await aFixtureProject(request);
    const chat = aChatSomebodyElseIsIn(project.path, 'Read the word on the rail');
    // "Working" is the word that showed it: the g is the only letter on any of
    // these marks that hangs below the line.
    const release = claimConversation(chat.id, { status: 'busy' });

    try {
      await openChatTab(page, project);
      const row = rowFor(page, chat.id);
      const mark = row.getByTestId('row-pill');
      await expect(mark).toHaveAttribute('data-working', 'yes', { timeout: 30_000 });
      await expect(mark).toHaveAttribute('data-word', 'Working');

      // The small mark gave its letters less room than the letters need and
      // hid the overflow, so the rail read "Workina" while the same word in
      // the open chat's line — drawn one size up — was whole (bw-96is.20).
      // Measured on the box that does the hiding, not on the badge around it:
      // the badge had height to spare, which is why this looked fine to
      // everything that measured the badge.
      const cut = await page.evaluate((id: string) => {
        const row_ = document.querySelector(`[data-testid="restore-row"][data-external-id="${id}"]`);
        const chip = row_?.querySelector('[data-testid="row-pill"]');
        const word = chip?.querySelector('span');
        if (!word) return null;
        return { shown: word.clientHeight, needed: word.scrollHeight, text: word.textContent ?? '' };
      }, chat.id);
      expect(cut, 'the working row drew no word at all').not.toBeNull();
      expect(cut!.text, 'the mark is not the one this case measures').toContain('Working');
      expect(
        cut!.needed,
        `the word is ${cut!.needed}px tall in a ${cut!.shown}px box, so its tails are cut off`,
      ).toBeLessThanOrEqual(cut!.shown);
    } finally {
      release();
    }
    chat.forget();
  });

  test('keeps the mark itself whole on the row the reader has open', async ({ page, request }) => {
    test.setTimeout(180_000);
    const project = await aFixtureProject(request);
    const chat = aChatSomebodyElseIsIn(project.path, 'Read the mark on the open row');
    // At rest, which is the case that broke: a working mark is filled with the
    // theme's primary and was never in danger.
    const release = claimConversation(chat.id, { status: 'idle' });

    try {
      await openChatTab(page, project);
      const row = rowFor(page, chat.id);
      const mark = row.getByTestId('row-pill');
      await expect(mark).toHaveAttribute('data-working', 'no', { timeout: 30_000 });

      await row.getByTestId('row-name').click();
      await expect(page.getByTestId('transcript')).toBeVisible({ timeout: 30_000 });
      await expect(row, 'the row left the rail when it was opened').toBeVisible();

      const box = await mark.boundingBox();
      expect(box, 'the mark drew no box on the row the reader has open').not.toBeNull();
      expect(box!.width, 'the mark drew nothing wide').toBeGreaterThan(0);
      expect(box!.height, 'the mark drew nothing tall').toBeGreaterThan(0);

      // The measured fault: an idle mark is filled with `secondary`, and in
      // every theme this app ships that is the same colour as `accent`, which
      // is what fills the selected row — so "Idle" lost its shape on exactly
      // the row he is looking at and read as loose text (bw-96is.16). Read off
      // the drawn pixels, not a class, and compared against the row BEHIND it
      // rather than against a token, because that is what the eye does.
      const apart = await page.evaluate((id: string) => {
        const row_ = document.querySelector(`[data-testid="restore-row"][data-external-id="${id}"]`);
        const chip = row_?.querySelector('[data-testid="row-pill"]');
        if (!row_ || !chip) return null;
        const a = getComputedStyle(chip);
        const b = getComputedStyle(row_);
        return {
          fill: a.backgroundColor,
          edge: a.borderTopColor,
          edgeWidth: parseFloat(a.borderTopWidth),
          behind: b.backgroundColor,
        };
      }, chat.id);
      expect(apart, 'the open row drew no mark').not.toBeNull();

      const invisible = /rgba\(0, 0, 0, 0\)|transparent/;
      const held =
        (apart!.fill !== apart!.behind && !invisible.test(apart!.fill)) ||
        (apart!.edgeWidth > 0 && !invisible.test(apart!.edge) && apart!.edge !== apart!.behind);
      expect(
        held,
        `the mark has neither a fill nor an edge of its own: fill ${apart!.fill}, edge ${apart!.edge}, row ${apart!.behind}`,
      ).toBe(true);
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

  /**
   * The marks on a row and the marks on the open chat's own line are one size.
   *
   * The manager photographed them side by side: the same chip, drawn a step
   * smaller on the list than in the chat beside it, so its word sat one point
   * off each edge instead of four and the row read as crammed and high
   * (bw-jaoz.1). Measured off the drawn boxes rather than off a class name,
   * because a class name is what the two screens disagreed about while both
   * believed they were drawing the same chip.
   */
  test('draws its marks at one size, on the row and on the open chat’s own line', async ({ page, request }) => {
    test.setTimeout(180_000);
    const project = await aFixtureProject(request);
    const opening = 'Measure the chips';
    const chat = aChatSomebodyElseIsIn(project.path, opening);
    const release = claimConversation(chat.id, { status: 'busy' });

    try {
      await openChatTab(page, project);
      const row = rowFor(page, chat.id);
      await expect(row.getByTestId('row-pill')).toHaveAttribute('data-working', 'yes', { timeout: 30_000 });
      await row.getByTestId('row-name').click();
      await expect(page.getByTestId('transcript').getByText(opening)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('session-state-chip')).toBeVisible({ timeout: 30_000 });

      /** The chip's own box, and the box its word is drawn in. */
      const measure = async (chip: ReturnType<Page['getByTestId']>) => {
        const box = await chip.boundingBox();
        expect(box, 'a chip drew no box at all').not.toBeNull();
        const word = await chip.evaluate((el) => {
          const said = el.getAttribute('data-word') ?? '';
          const span = Array.from(el.querySelectorAll('span')).find((s) => s.textContent?.trim() === said.trim());
          const r = span?.getBoundingClientRect();
          return r ? { top: r.top, bottom: r.bottom } : null;
        });
        expect(word, 'a chip drew no word to measure').not.toBeNull();
        return { box: box!, word: word! };
      };

      const onRow = await measure(row.getByTestId('row-pill'));
      const onLine = await measure(page.getByTestId('session-state-chip'));

      expect(
        onRow.box.height,
        `the row's chip is ${onRow.box.height}px tall and the chat's own line draws the same chip at ${onLine.box.height}px`,
      ).toBeCloseTo(onLine.box.height, 0);

      // Clear of both edges, and by the same amount top and bottom: a word
      // pressed against the top of its chip is what "sitting high" was.
      for (const [where, chip] of [['row', onRow], ['line', onLine]] as const) {
        const above = chip.word.top - chip.box.y;
        const below = chip.box.y + chip.box.height - chip.word.bottom;
        expect(above, `the word on the ${where}'s chip touches its top edge`).toBeGreaterThan(0);
        expect(below, `the word on the ${where}'s chip touches its bottom edge`).toBeGreaterThan(0);
        expect(
          Math.abs(above - below),
          `the word on the ${where}'s chip sits ${above}px from the top and ${below}px from the bottom`,
        ).toBeLessThanOrEqual(1);
      }

      // The badge beside it is the other half of what he compared, and it is
      // drawn from the same size.
      const badge = await row.getByTestId('chat-external').boundingBox();
      expect(badge, 'the row drew no badge').not.toBeNull();
      expect(
        badge!.height,
        `the badge is ${badge!.height}px tall against the chip's ${onRow.box.height}px`,
      ).toBeCloseTo(onRow.box.height, 0);
    } finally {
      release();
    }
    chat.forget();
  });

  /**
   * The command they are running now, on the screen while it runs.
   *
   * The record's tail is held back from SETTLING, never from the screen: a
   * two-minute command used to be two minutes of blank chat beside a terminal
   * saying `Bash(…) Running… 14s` the whole time, and the foot of the chat drew
   * nothing at all because it asked whether a driver of OURS was busy
   * (bw-jaoz.3, bw-jaoz.5).
   */
  test('draws the command its holder is running, and settles that same row', async ({ page, request }) => {
    test.setTimeout(180_000);
    const project = await aFixtureProject(request);
    const opening = 'Run the suite';
    const chat = aChatSomebodyElseIsIn(project.path, opening);
    const release = claimConversation(chat.id, { status: 'busy' });

    try {
      await openChatTab(page, project);
      await expect(rowFor(page, chat.id)).toBeVisible({ timeout: 30_000 });
      await rowFor(page, chat.id).getByTestId('row-name').click();
      await expect(page.getByTestId('transcript').getByText(opening)).toBeVisible({ timeout: 30_000 });

      // Their terminal starts a command; nothing has come back yet.
      const call = chat.runs('Bash', { command: 'npm test' });
      const drawn = page.locator('[data-testid="tool-row"][data-tool-name="Bash"]');
      await expect(drawn, 'the command they are running is not on the screen').toHaveCount(1, { timeout: 30_000 });
      await expect(drawn).toHaveAttribute('data-tool-status', 'running');

      // And the foot of the chat says the same thing the chip above it does.
      const foot = page.getByTestId('working-line');
      await expect(foot, 'the body of a held chat says nothing while its holder works').toBeVisible({
        timeout: 30_000,
      });
      await expect(foot).toContainText('npm test');

      // What it printed lands: the row already standing is the row that
      // settles, and there is never a second one.
      chat.printed(call, '313 passed, 0 failed');
      await expect(drawn).toHaveAttribute('data-tool-status', 'ok', { timeout: 30_000 });
      await expect(drawn, 'the settled command was drawn a second time').toHaveCount(1);
    } finally {
      release();
    }
    chat.forget();
  });

  /**
   * A compaction, which is the one thing a chat does that has a length.
   *
   * The manager's screenshot, 2026-08-22: a chat summarising itself drew a
   * spinner, a stale command and `Working 1h 38m`, so nothing on the screen
   * said what was happening or how much of it was left. Everything else a chat
   * does is open-ended and gets a word and a clock; this gets a bar, because
   * this project's own runs have a measured middle (bw-jaoz.14.5).
   *
   * A real session cannot be told to compact on cue, so the line its hook would
   * have written is written here — the same file, the same shape, read by the
   * same code (`workbench/hooks/session-doing.py`, bw-jaoz.14.6).
   */
  test('draws a filling bar while it summarises itself', async ({ page, request }) => {
    test.setTimeout(180_000);
    const project = await aFixtureProject(request);
    const opening = 'Summarise where we got to';
    const chat = aChatSomebodyElseIsIn(project.path, opening);
    const release = claimConversation(chat.id, { status: 'busy' });
    // Sixty-two seconds in: half of the middle run measured on this machine, so
    // the bar is caught halfway rather than at either end (summarising.ts).
    const quiet = saysItIsDoing(chat.id, 'summarising', { ago: 62_000, detail: 'auto' });

    try {
      await openChatTab(page, project);
      await expect(rowFor(page, chat.id)).toBeVisible({ timeout: 30_000 });
      await rowFor(page, chat.id).getByTestId('row-name').click();
      await expect(page.getByTestId('transcript').getByText(opening)).toBeVisible({ timeout: 30_000 });

      // The word first: a marker's busy bit cannot tell this state from any
      // other, and the whole point of the line beside it is that this one is
      // named rather than guessed.
      const foot = page.getByTestId('working-line');
      await expect(foot, 'the foot of a summarising chat says nothing').toBeVisible({ timeout: 30_000 });
      await expect(foot, 'it is drawn as ordinary work, which is what it was').toContainText('Summarising', {
        timeout: 30_000,
      });

      const bar = page.getByTestId('summarising-bar');
      await expect(bar, 'the one run with a length gets the one bar').toBeVisible({ timeout: 30_000 });
      const filled = Number(await bar.getAttribute('data-fill'));
      expect(filled, 'caught mid-run: neither empty nor held at the top').toBeGreaterThan(20);
      expect(filled).toBeLessThan(80);
      expect(await bar.getAttribute('data-held'), 'a run inside its estimate is not overrunning').toBe('false');

      // The picture the manager judges this by, beside the one he sent.
      mkdirSync('tests/results', { recursive: true });
      await page.screenshot({ path: 'tests/results/chat-summarising-bar.png', fullPage: false });
    } finally {
      quiet();
      release();
    }
    chat.forget();
  });

  /**
   * The five states side by side, which is the picture the job is judged by.
   *
   * The manager's screenshot, 2026-08-22: one chat, one word, `Working 1h 38m`.
   * Everything a chat could be doing arrived on the screen as that word, because
   * the only thing read off a running session was a busy bit — so a two-minute
   * compaction, a think, a permission prompt nobody had answered, a wait on a
   * usage limit and three helpers grinding away all read the same (bw-jaoz.14).
   *
   * Each of the five is its own word, its own mark, and — for the two a clock
   * cannot see the end of — the thing beside the word that says which retry or
   * whose work (bw-jaoz.14.7). Read off the rows rather than five separate
   * chats' own pages, because reading them side by side is the whole complaint:
   * five rows that used to be indistinguishable.
   */
  test('says which of the five things it is doing, each with its own word and mark', async ({ page, request }) => {
    test.setTimeout(300_000);
    const project = await aFixtureProject(request);
    /** What each of the five looks like, in the order the picture reads. */
    const FIVE = [
      { doing: 'summarising', word: 'Summarising', mark: 'summarising', detail: 'auto', ago: 62_000, bar: true },
      { doing: 'thinking', word: 'Thinking', mark: 'thinking', detail: null, ago: 14_000, bar: false },
      { doing: 'waiting', word: 'Waiting for you', mark: 'waiting', detail: 'Bash', ago: 240_000, bar: false },
      { doing: 'retrying', word: 'Retrying', mark: 'retrying', detail: 'resets 4:40pm', ago: 30_000, bar: false },
      { doing: 'helping', word: 'Helper working', mark: 'helping', detail: '3 helpers', ago: 95_000, bar: false },
    ] as const;

    const made = FIVE.map((it) => {
      const chat = aChatSomebodyElseIsIn(project.path, `A chat that is ${it.doing}`);
      return {
        ...it,
        chat,
        release: claimConversation(chat.id, { status: 'busy' }),
        quiet: saysItIsDoing(chat.id, it.doing, { ago: it.ago, detail: it.detail ?? undefined }),
      };
    });

    try {
      await openChatTab(page, project);
      for (const one of made) {
        const row = rowFor(page, one.chat.id);
        await expect(row, `the ${one.doing} chat was not offered`).toBeVisible({ timeout: 30_000 });
        const pill = row.getByTestId('row-pill');
        // Its own word, and never the one word they all used to share.
        await expect(pill, one.doing).toHaveAttribute('data-word', one.word, { timeout: 30_000 });
        // Its own mark beside it: five words in one typeface still read alike
        // at a glance, and the mark is what makes them different at a glance.
        await expect(pill.getByTestId('chat-state-mark')).toHaveAttribute('data-mark', one.mark);
        // The badge saying whose chat this is stays beside all five, because it
        // was never an answer to what the chat is doing (bw-96is).
        await expect(row.getByTestId('chat-external')).toBeVisible();
        // Which one it is — "auto", "3 helpers" — is not said here. The rail is
        // 288px wide and the clause arrived truncated to a stub of itself, so
        // it moved to the chat's own bar, which is checked below on the one
        // chat this test opens (the manager, 2026-08-23).
        await expect(
          pill.getByTestId('chat-state-detail'),
          `${one.doing} spent the rail's width on a clause it cannot finish`,
        ).toHaveCount(0);
      }

      // The picture the manager judges the job by: five rows, five states.
      mkdirSync('tests/results', { recursive: true });
      await page.screenshot({ path: 'tests/results/chat-five-states.png', fullPage: false });

      // And the one of them with a length gets the bar, in its own chat, which
      // no other state may draw.
      const summarising = made[0]!;
      await rowFor(page, summarising.chat.id).getByTestId('row-name').click();
      await expect(page.getByTestId('working-line')).toContainText('Summarising', { timeout: 30_000 });
      // And here, where there is room for it, which compaction it is: the rail
      // dropping the clause must not mean nobody says it at all.
      await expect(
        page.getByTestId('session-state-chip').getByTestId('chat-state-detail'),
        'the chat that dropped the clause from the rail does not say it anywhere',
      ).toContainText(summarising.detail!, { timeout: 30_000 });
      await expect(page.getByTestId('summarising-bar')).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: 'tests/results/chat-state-summarising.png', fullPage: false });

      const thinking = made[1]!;
      await rowFor(page, thinking.chat.id).getByTestId('row-name').click();
      await expect(page.getByTestId('working-line')).toContainText('Thinking', { timeout: 30_000 });
      await expect(
        page.getByTestId('summarising-bar'),
        'a think has no measured length, so it may not draw a bar',
      ).toHaveCount(0);
    } finally {
      for (const one of made) {
        one.quiet();
        one.release();
      }
    }
    for (const one of made) one.chat.forget();
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
