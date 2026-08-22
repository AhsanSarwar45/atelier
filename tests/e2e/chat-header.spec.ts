import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { writeChatWithHelper } from './fixture-record';

/**
 * The line above a conversation, on a screen with both columns open.
 *
 * It carries what the chat is, where it is running, how full it is, what it has
 * spent and how much of the account's allowance is left — and it must carry all
 * of that in one line's height without anything drawing over anything else.
 *
 * It is measured rather than looked at, because the way this line failed leaves
 * every box in the right place: a chip squeezed under its own text keeps its
 * position and spills the words sideways over its neighbour, so a picture shows
 * two names on top of each other while the rectangles are all still in a row
 * (bw-7ks.22.15). Hence both readings — where the boxes are, and whether each
 * one still holds its own words.
 *
 * It runs on the isolated stack because it needs a chat with real numbers on
 * it: what a chat is using, what it cost and what the account has left only
 * exist once an agent has answered something.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-header.spec.ts
 */

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** Starting an agent is a process launch. */
const HELLO_MS = 120_000;

/** One word, from a cold agent. */
const ANSWER_MS = 180_000;

/** A folder of its own, so this case never runs an agent in someone's work. */
const FIXTURE = join(__dirname, '..', '.workbench-run-header');

/**
 * And a second one for the chat this app never ran. It is a folder of its own
 * so the record written into it is the only chat that project offers, and the
 * row this case clicks cannot be some other run's leftover. Its name is short
 * on purpose: the folder chip is capped at ten rem and truncates a longer one
 * whatever room the line has, which would say nothing about who gave way.
 */
const OUTSIDE = join(__dirname, '..', '.workbench-outside');

/**
 * And a third, for the chat nobody clicks. It has to be a folder of its own for
 * the same reason: the case reloads the page onto one chat's address, and a
 * project offering two would let a leftover answer for it.
 */
const ADDRESSED = join(__dirname, '..', '.workbench-addressed');

/** The mode that record opens in, before anybody reloads anything. */
const FIRST_MODE = 'acceptEdits';

/** And the picker's own words for it. */
const FIRST_SAID = 'Edit freely';

/**
 * The mode that record is left in. It is the loud one on purpose: the whole
 * reason this line is read is that a chat which has quietly stopped asking
 * before it runs things is a trap.
 */
const RUNNING_MODE = 'bypassPermissions';

/** What a reader must see instead — the picker's own words for that setting. */
const RUNNING_SAID = 'Skip all checks';

/**
 * The model on that record's own replies, and the name a reader is shown for it.
 *
 * Nothing is driving that chat, so no list of display names was ever announced
 * for it — but the name is not the list's to give. It is the one every place
 * that prints a model reads out of `modelName`, spelled the way the terminal
 * spells it, so the tag here and the picker under the writing box cannot say
 * two different things about one setting (what-it-runs.tsx, bw-ja9l.11).
 */
const RUNNING_MODEL = 'claude-opus-5';
const RUNNING_MODEL_SAID = 'Opus 5';

/** A narrow window, where the line has the least room it is ever given. */
const CRAMPED = { width: 720, height: 900 };

/** The width this is claimed at, with a column down each side. */
const SCREEN = { width: 1440, height: 900 };

/** Rounding in the browser's own numbers, not a gap anyone can see. */
const HAIR = 0.5;

/** Everything the line draws, in the order it draws it. */
const PIECES = [
  'session-state',
  'session-meta',
  'chat-folder-chip',
  'context-chip',
  'cost-chip',
  'plan-chips',
] as const;

/** The pieces that must never lose a character: a half-drawn number is a lie. */
const WHOLE = PIECES.filter((p) => p !== 'session-meta');

type Piece = { name: string; left: number; right: number; wants: number; has: number };

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
  const made = await request.post('/api/projects', {
    data: { name, path, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/**
 * What the browser makes of one piece of the line, live: where it sits, whether
 * it is holding all of its own words, and whether the row it is in is allowed
 * to squeeze it. `flex-shrink` is read off the rendered page rather than off a
 * class list, because the class list is what was asked for and this is what the
 * browser did with it.
 */
type Measured = { left: number; right: number; width: number; wants: number; has: number; gives: number };

const measure = (page: Page, name: string): Promise<Measured | null> =>
  page.evaluate((testid) => {
    const el = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      width: box.width,
      wants: el.scrollWidth,
      has: el.clientWidth,
      gives: Number.parseFloat(getComputedStyle(el).flexShrink),
    };
  }, name);

test.describe('the line above a conversation', () => {
  test.use({ viewport: SCREEN });
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    for (const dir of [FIXTURE, OUTSIDE, ADDRESSED]) {
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

  test('holds every number it carries without drawing over itself', async ({ page, request }) => {
    const project = await fixtureProject(request, 'workbench-header', FIXTURE);
    const started = (await (
      await request.post('/api/workbench/command', {
        data: {
          type: 'session.start',
          projectId: project.id,
          projectPath: project.path,
          brand: 'claude',
          permissionMode: 'bypassPermissions',
        },
      })
    ).json()) as { id: string };

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

    // One word back, which is what puts numbers on the line: what the chat is
    // using, what it has spent, and what the account has left.
    const asked = await request.post('/api/workbench/command', {
      data: { type: 'prompt.send', sessionId: started.id, text: 'Reply with the single word OK and nothing else.' },
    });
    expect(asked.ok(), `the chat would not take the prompt: ${asked.status()}`).toBe(true);
    await page.getByTestId('context-chip').waitFor({ timeout: ANSWER_MS });

    // Both columns open, because that is the screen this is claimed at: the
    // line has the least room when the conversation has the least room.
    await expect(page.getByTestId('chat-right-rail')).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('chat-sidebar')).toBeVisible();

    const line = page.getByTestId('chat-status-line');
    const room = (await line.boundingBox())!;
    const drawn: Piece[] = await line.evaluate((el, names) => {
      const out: Piece[] = [];
      for (const name of names) {
        const found = el.querySelector(`[data-testid="${name}"]`) as HTMLElement | null;
        if (!found) continue;
        const box = found.getBoundingClientRect();
        out.push({ name, left: box.left, right: box.right, wants: found.scrollWidth, has: found.clientWidth });
      }
      return out;
    }, [...PIECES]);

    const there = new Set(drawn.map((p) => p.name));
    for (const must of ['session-meta', 'chat-folder-chip', 'context-chip', 'plan-chips']) {
      expect(there.has(must), `the line drew no ${must}, so this proves nothing about it`).toBe(true);
    }

    // Nothing on top of anything: each piece starts where the last one ended.
    for (let i = 1; i < drawn.length; i += 1) {
      const before = drawn[i - 1]!;
      const now = drawn[i]!;
      expect(
        now.left,
        `${now.name} starts at ${now.left} — ${before.name} is still going at ${before.right}`,
      ).toBeGreaterThanOrEqual(before.right - HAIR);
    }

    // And nothing hanging off the end of the line, where it is simply cut.
    for (const piece of drawn) {
      expect(piece.right, `${piece.name} runs past the end of the line`).toBeLessThanOrEqual(
        room.x + room.width + HAIR,
      );
    }

    // Every chip still holds its own words. This is the reading the failure was
    // hiding behind: the box stays put and the text walks out of it.
    for (const piece of drawn.filter((p) => WHOLE.includes(p.name as (typeof WHOLE)[number]))) {
      expect(piece.wants, `${piece.name} is drawn ${piece.has}px wide and needs ${piece.wants}px`).toBeLessThanOrEqual(
        piece.has + 1,
      );
    }

    await page.screenshot({ path: `${SHOTS}/chat-status-line.png`, clip: { ...room } });

    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: started.id } });
  });
  /**
   * The same line above a chat this app never started.
   *
   * Two faults met on it. It printed the tool's own spelling — `permission
   * mode: bypassPermissions` as a run of grey text — an inch from a picker
   * calling that setting "Skip all checks" (bw-ja9l.1); and above a chat begun
   * in a terminal it printed neither the mode nor the model at all, because
   * both reach the screen only where this app is driving the agent
   * (bw-ja9l.2).
   *
   * So this writes a record of the kind the kit writes, opens it for reading,
   * and asks the line what that chat is running. Nothing here starts an agent,
   * which is the point: every word on the line has to have come off the file.
   *
   * The model is the proof that it did. The row this app stores for such a
   * chat holds no model at all and a mode copied from the owner's own settings
   * — a guess about this machine, not about the terminal that chat ran in — and
   * nothing publishes either. A model on the line can only have been read.
   */
  test('says what a chat begun in a terminal is running, in the same words', async ({ page, request }) => {
    const project = await fixtureProject(request, 'workbench-header-outside', OUTSIDE);
    const written = writeChatWithHelper({
      cwd: OUTSIDE,
      sessionId: randomUUID(),
      card: 'bw-ja9l',
    });

    // The line the kit writes every time somebody changes the mode, appended
    // the way the kit appends it. Two of them, because the answer is the LAST
    // one and a reader who is shown the first is being told the wrong thing.
    for (const mode of ['acceptEdits', RUNNING_MODE]) {
      appendFileSync(
        written.path,
        JSON.stringify({ type: 'permission-mode', permissionMode: mode, sessionId: written.sessionId }) + '\n',
      );
    }

    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: HELLO_MS });

      // Opened by its name, which reads it. Nothing resumes it.
      const listed = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
      await listed.waitFor({ timeout: HELLO_MS });
      await listed.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

      // ---- the words -------------------------------------------------------
      const mode = page.getByTestId('chat-mode-chip');
      await expect(mode).toHaveText(RUNNING_SAID, { timeout: HELLO_MS });
      // Read off that record and no other: the mode it was last put in, not
      // the one it opened in, and not the owner's own setting.
      await expect(mode).toHaveAttribute('data-mode', RUNNING_MODE);
      // And said loudly, because this is the mode that stops asking.
      await expect(mode).toHaveAttribute('data-tone', 'destructive');

      const model = page.getByTestId('chat-model-chip');
      await expect(model).toHaveText(RUNNING_MODEL_SAID);
      await expect(model).toHaveAttribute('data-model', RUNNING_MODEL);

      // The wire word is nowhere a reader can see it — not in the text and not
      // in a tooltip, which is the one other place words on this line hide.
      const line = page.getByTestId('chat-status-line');
      const seen = await line.evaluate((el) => {
        const titles = Array.from(el.querySelectorAll('[title]'), (t) => t.getAttribute('title') ?? '');
        return [el.textContent ?? '', ...titles].join(' | ');
      });
      expect(seen, 'the line still says the setting in the tool’s own spelling').not.toContain(RUNNING_MODE);

      // The folder comes off a later event than the words above do; the whole
      // line has to be standing before it is either measured or photographed.
      await page.getByTestId('chat-folder-chip').waitFor({ timeout: HELLO_MS });

      await page.screenshot({
        path: `${SHOTS}/chat-header-outside.png`,
        clip: { ...(await line.boundingBox())! },
      });

      // ---- the width -------------------------------------------------------
      // This pair is the one thing on the line allowed to give way, and the
      // folder chip beside it is the one thing that must not: both are named
      // again on the writing box below, while a half-drawn folder name is a
      // lie about which copy of a project this is (bw-7ks.22.15).
      const wideGroup = (await measure(page, 'session-meta'))!;
      const wideFolder = (await measure(page, 'chat-folder-chip'))!;
      expect(wideGroup.gives, 'the pair is pinned at its full width').toBeGreaterThan(0);
      expect(wideFolder.gives, 'the folder chip can be squeezed').toBe(0);

      await page.setViewportSize(CRAMPED);
      await expect(page.getByTestId('chat-status-line')).toBeVisible();
      const tightGroup = (await measure(page, 'session-meta'))!;
      const tightFolder = (await measure(page, 'chat-folder-chip'))!;

      // The pair gave the room up and the folder chip did not lose a pixel.
      expect(
        tightGroup.width,
        `the pair kept ${tightGroup.width}px of the ${wideGroup.width}px it had on a wide screen`,
      ).toBeLessThan(wideGroup.width);
      expect(tightFolder.width, 'the folder chip was squeezed to make room').toBeCloseTo(wideFolder.width, 0);

      // And the chip that never gives way still holds every character of its
      // own name, which is the reading the old failure hid behind: the box
      // stays put and the text walks sideways out of it.
      expect(
        tightFolder.wants,
        `the folder chip is drawn ${tightFolder.has}px wide and needs ${tightFolder.wants}px`,
      ).toBeLessThanOrEqual(tightFolder.has + 1);

      // Nothing on top of anything at that width either.
      const cramped = (await page.getByTestId('chat-status-line').boundingBox())!;
      expect(tightGroup.right, 'the pair runs into the folder chip').toBeLessThanOrEqual(tightFolder.left + HAIR);
      expect(tightFolder.right, 'the folder chip hangs off the end of the line').toBeLessThanOrEqual(
        cramped.x + cramped.width + HAIR,
      );

      await page.screenshot({ path: `${SHOTS}/chat-header-outside-cramped.png`, clip: { ...cramped } });
    } finally {
      written.remove();
    }
  });

  /**
   * The same line, above a chat nobody clicked.
   *
   * Every other way into a chat is its address: a link on a card, a hit in the
   * search panel, the browser's own reload. Only a click on a sleeping row in
   * the list ever told the sidecar a chat was being read, and only that started
   * the reading of its record — so a reloaded page drew a header frozen at
   * whatever it said when somebody last clicked, above a conversation that
   * never grew again (bw-ja9l.8).
   *
   * The terminal is put into another mode AFTER the reload, with no click
   * anywhere in between. A line that answers that can only have read the file.
   */
  test('reads the record for a chat opened by its address alone', async ({ page, request }) => {
    const project = await fixtureProject(request, 'workbench-header-addressed', ADDRESSED);
    const written = writeChatWithHelper({
      cwd: ADDRESSED,
      sessionId: randomUUID(),
      card: 'bw-ja9l',
    });
    appendFileSync(
      written.path,
      JSON.stringify({ type: 'permission-mode', permissionMode: FIRST_MODE, sessionId: written.sessionId }) + '\n',
    );

    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: HELLO_MS });
      const listed = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
      await listed.waitFor({ timeout: HELLO_MS });
      await listed.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
      await expect(page.getByTestId('chat-mode-chip')).toHaveText(FIRST_SAID, { timeout: HELLO_MS });

      // From here the address is the whole of what the screen is told: the
      // reload takes the click out of it and nothing puts one back.
      expect(page.url(), 'the chat is not named in the address').toContain('chat=');
      await page.reload();
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

      const mode = page.getByTestId('chat-mode-chip');
      const model = page.getByTestId('chat-model-chip');
      await expect(mode).toHaveText(FIRST_SAID, { timeout: HELLO_MS });
      await expect(model).toHaveText(RUNNING_MODEL_SAID);
      await expect(model).toHaveAttribute('data-model', RUNNING_MODEL);

      // Read rather than remembered: the mode changes with the page already
      // standing, and the line has to answer it.
      appendFileSync(
        written.path,
        JSON.stringify({ type: 'permission-mode', permissionMode: RUNNING_MODE, sessionId: written.sessionId }) + '\n',
      );
      await expect(mode).toHaveText(RUNNING_SAID, { timeout: HELLO_MS });
      await expect(mode).toHaveAttribute('data-mode', RUNNING_MODE);
      await expect(mode).toHaveAttribute('data-tone', 'destructive');
    } finally {
      written.remove();
    }
  });
});
