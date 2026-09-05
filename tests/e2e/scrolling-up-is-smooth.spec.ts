import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { discardFixture, makeFixtureProject } from './fixture-board';
import {
  raggedChatSaid,
  raggedChatSaidWithPictures,
  writeLongChat,
  type LongChat,
  type Spoken,
} from './fixture-record';

/**
 * Scrolling up through a long chat, and what it does to the words being read.
 *
 * The chat draws only the rows in the pane and a band around them, and guesses
 * the height of every row it has not drawn yet. A guess is wrong by however far
 * the row it stands for is from an average one — and the moment the real row is
 * drawn and measured, everything below it moves by the difference. If nobody
 * puts the pane back, the reader's own line jumps.
 *
 * Every case here holds the same one line: THE ROW THE READER IS HOLDING ON TO
 * MOVES BY WHAT HE ASKED THE WHEEL FOR AND NOT A PIXEL MORE — while he is
 * turning it, and not at all once he has stopped. It is read against the pane
 * rather than the page, because a pane put back by the app moves under a row
 * that does not, and that is the fix working rather than the fault.
 *
 * "Once he has stopped" is counted from the frame the last turn was delivered
 * in, not from the first still frame. Turns arrive 40ms apart and a frame is
 * 16ms, so the gap between two turns is three still frames — and a watch that
 * calls that rest reports the whole rest of the reader's own gesture as a jump
 * of a hundred pixels and more, on a chat that is behaving perfectly (bw-cdav.2).
 *
 * The conversation is deliberately ragged: a one-line answer above a forty-line
 * one, the way a real chat reads. Every earlier scrolling case is built on
 * messages that are all one line, where every guess is right and none of this
 * can be seen (bw-cdav).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/scrolling-up-is-smooth.spec.ts
 */

const HELLO_MS = 120_000;

/** How far the row being read may drift while nobody is scrolling. */
const STILL = 4;

/** How far the reader wheels in one go, and how far the row must therefore move. */
const WHEEL = 200;

/** How many messages the chat holds. Several pages of forty. */
const HELD = 200;

const RUN = join(__dirname, '..', '.workbench-run-smooth');

const SHOTS = join(process.cwd(), 'tests', 'results');

interface Ground {
  projectId: string;
  chat: LongChat;
  away: () => Promise<void>;
}

async function makeGround(
  request: APIRequestContext,
  called: string,
  said: (n: number) => Spoken,
): Promise<Ground> {
  const where = join(RUN, called);
  const project = join(where, 'project');
  discardFixture(where);
  mkdirSync(where, { recursive: true });
  makeFixtureProject(project, join(where, 'reporting'));
  // Unmarked on purpose. A project marked `isTest` is left out of
  // `GET /api/projects`, which is the only list the project screen reads — so
  // the screen draws "This project could not be read" and a case that navigates
  // to one can do nothing at all (bw-1cqk). It is deleted below, and the run's
  // whole data directory is thrown away before the next one.
  const made = await request.post('/api/projects', {
    data: { name: `workbench-smooth-${called}`, path: project },
  });
  expect(made.status(), await made.text()).toBe(201);
  const listed = (await made.json()) as { id: string };
  const chat = writeLongChat({ cwd: project, sessionId: randomUUID(), held: HELD, said });
  return {
    projectId: listed.id,
    chat,
    away: async () => {
      chat.remove();
      await request.delete(`/api/projects/${listed.id}`);
    },
  };
}

/** Opens the chat and waits until its end is drawn and standing still. */
async function readChat(page: Page, ground: Ground): Promise<void> {
  await page.goto(`/project?id=${ground.projectId}&tab=chat`);
  await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: HELLO_MS });
  const row = page.locator(`[data-testid="restore-row"][data-external-id="${ground.chat.sessionId}"]`);
  await row.waitFor({ timeout: HELLO_MS });
  await row.getByTestId('row-name').click();
  await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
  await page.getByTestId('virtual-transcript').waitFor({ timeout: HELLO_MS });
  await settled(page);
}

async function place(page: Page): Promise<{ top: number; end: number; loaded: number }> {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid="transcript"]') as HTMLElement;
    const drawn = document.querySelector('[data-testid="virtual-transcript"]') as HTMLElement | null;
    return {
      top: box.scrollTop,
      end: box.scrollHeight - box.clientHeight,
      loaded: Number(drawn?.dataset.loadedItems ?? 0),
    };
  });
}

async function settled(page: Page, still = 400, most = 30_000): Promise<void> {
  const until = Date.now() + most;
  let was = await place(page);
  while (Date.now() < until) {
    await page.waitForTimeout(still);
    const now = await place(page);
    if (now.loaded === was.loaded && Math.abs(now.end - was.end) < 1) return;
    was = now;
  }
}

/** One frame of the watch below: where the pane is, and where the row is in it. */
interface Frame {
  top: number;
  row: number | null;
}

interface Watched {
  /** The row the watch was following, by the chat's own key for it. */
  key: string;
  frames: Frame[];
  /** How far the row moved after the wheel was spent and it had come to rest. */
  drift: number;
  /** The whole of the pane's own travel, so a case can say the wheel worked. */
  travelled: number;
  /** Which frame it came to rest in, or -1 if it never did. */
  rest: number;
  /** How far down the pane the row ended up, from where it started. */
  moved: number | null;
}

/**
 * Starts following the row at the top of the pane, frame by frame.
 *
 * Frame by frame rather than before-and-after: a jump is over in one frame and
 * a pane that lands back where it started leaves nothing to find afterwards.
 */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const box = document.querySelector('[data-testid="transcript"]') as HTMLElement;
    const seen = () => box.getBoundingClientRect();
    const rows = [...box.querySelectorAll<HTMLElement>('[data-transcript-key]')];
    const found = rows.find((r) => r.getBoundingClientRect().top > seen().top + 8) ?? rows[0];
    const key = found?.dataset.transcriptKey ?? '';
    const state: {
      key: string;
      frames: { top: number; row: number | null }[];
      raf: number;
      /** The frame the last wheel turn was delivered in; -1 until it is. */
      spent: number;
    } = {
      key,
      frames: [],
      raf: 0,
      spent: -1,
    };
    (window as unknown as { __smooth?: typeof state }).__smooth = state;
    const look = () => {
      const el = box.querySelector<HTMLElement>(`[data-transcript-key="${CSS.escape(key)}"]`);
      state.frames.push({
        top: box.scrollTop,
        row: el ? el.getBoundingClientRect().top - seen().top : null,
      });
      state.raf = requestAnimationFrame(look);
    };
    look();
  });
}

/** Stops the watch and reads what it saw. */
async function stopWatch(page: Page): Promise<Watched> {
  return page.evaluate(() => {
    const state = (window as unknown as {
      __smooth?: { key: string; frames: Frame[]; raf: number; spent: number };
    }).__smooth;
    if (!state) throw new Error('nothing was being watched');
    cancelAnimationFrame(state.raf);
    const frames = state.frames;
    let travelled = 0;
    for (let i = 1; i < frames.length; i += 1) {
      travelled += Math.abs(frames[i]!.top - frames[i - 1]!.top);
    }
    // Where the row came to rest once the wheel was spent: the first still frame
    // after the last turn was delivered. Counting from the start instead finds
    // the 40ms gap BETWEEN two turns — three frames at 60Hz, every one of them
    // still — and calls the rest of the reader's own gesture a jump.
    let rest = -1;
    for (let i = Math.max(3, state.spent); i < frames.length; i += 1) {
      const still =
        Math.abs(frames[i]!.top - frames[i - 1]!.top) <= 0.5 &&
        Math.abs(frames[i - 1]!.top - frames[i - 2]!.top) <= 0.5 &&
        Math.abs(frames[i - 2]!.top - frames[i - 3]!.top) <= 0.5;
      if (still && frames[i]!.row !== null) {
        rest = i;
        break;
      }
    }
    // From there on nothing the reader did can move that row. Whatever moves it
    // is the chat moving the words under him, which is the whole fault.
    let drift = 0;
    if (rest >= 0) {
      const settled = frames[rest]!.row!;
      for (let i = rest + 1; i < frames.length; i += 1) {
        const row = frames[i]!.row;
        if (row === null) continue;
        drift = Math.max(drift, Math.abs(row - settled));
      }
    }
    // What the reader actually got for his wheel. He asked for so many pixels
    // of conversation; the row he was reading must be exactly that far down the
    // pane afterwards, whatever the chat did to its own offset in between —
    // loading a page above him, measuring a row it had only guessed at, or
    // putting the pane back after either. Anything else is the words moving
    // under him, and the difference IS the jump.
    const first = frames.find((f) => f.row !== null)?.row ?? null;
    let last: number | null = null;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      if (frames[i]!.row !== null) { last = frames[i]!.row; break; }
    }
    const moved = first === null || last === null ? null : last - first;
    return { key: state.key, frames, drift, travelled, rest, moved };
  });
}

/**
 * The reader wheels up and then reads, without touching anything else.
 *
 * `steps` is how the wheel is delivered. One shove lands between two frames and
 * is over before anything can be asked for; a real reader turns the wheel a
 * dozen times a second, so the page he asked for arrives WHILE he is still
 * turning it — and a pane put back underneath a scroll that is still running is
 * a different thing from one put back under a pane standing still.
 */
async function wheelsUpAndReads(
  page: Page,
  steps = 1,
  quiet = 1500,
  far = WHEEL,
): Promise<Watched> {
  await page.getByTestId('transcript').hover();
  await watch(page);
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, -far / steps);
    if (i + 1 < steps) await page.waitForTimeout(40);
  }
  await page.evaluate(() => {
    const state = (window as unknown as { __smooth?: { frames: unknown[]; spent: number } }).__smooth;
    if (state) state.spent = state.frames.length;
  });
  await page.waitForTimeout(quiet);
  return stopWatch(page);
}

/**
 * Puts the reader just short of the point where wheeling upward asks for an
 * older page — so the wheel that IS measured is the one that asks for it.
 *
 * Set outright rather than wheeled there: every row above the fold is measured
 * for the first time as it arrives, each one taller than the guess it replaces,
 * so the pane's offset grows almost as fast as a wheel shrinks it and the
 * travel takes minutes. None of that travel is what this case is about.
 */
async function justAboveTheMark(page: Page): Promise<void> {
  await page.evaluate(() => {
    const box = document.querySelector('[data-testid="transcript"]') as HTMLElement;
    // A page is asked for when an upward move leaves the pane within one
    // screenful of the top (drawn-transcript.tsx, `requestOlder`). Stop a
    // little above that, so nothing is asked for until the reader wheels.
    box.scrollTop = box.clientHeight + 40;
  });
  await page.waitForTimeout(400);
}

test.describe('scrolling up through a long chat', () => {
  test.describe.configure({ mode: 'serial' });

  // Every step of the walk below is a wheel and then a stretch of reading with
  // nothing touched, and there are two dozen of them, twice over.
  test.setTimeout(600_000);

  interface Step {
    step: number;
    drift: number;
    loaded: number;
    travelled: number;
    top: number;
    rest: number;
    moved: number | null;
    turns: number;
  }

  /**
   * Walks the reader up the chat until three older pages have been loaded,
   * reading what moved at every step.
   *
   * The wheel is delivered in eight turns on one step and one shove on the next,
   * because the two are different cases: a page that arrives while the wheel is
   * still turning, and a page that arrives with the pane standing still.
   */
  async function walksUp(page: Page, ground: Ground): Promise<Step[]> {
    await readChat(page, ground);
    const opened = await place(page);
    expect(opened.loaded, 'the chat did not open on a bounded window of its history').toBeGreaterThan(0);
    expect(opened.loaded, 'the chat opened on the whole conversation, so there is nothing to load').toBeLessThan(HELD);

    const worst: Step[] = [];
    let loaded = opened.loaded;
    let loads = 0;
    for (let step = 0; step < 12 && loads < 3; step += 1) {
      await justAboveTheMark(page);
      const turns = step % 2 === 0 ? 8 : 1;
      const saw = await wheelsUpAndReads(page, turns);
      const now = await place(page);
      if (now.loaded !== loaded) loads += 1;
      worst.push({
        step,
        drift: Math.round(saw.drift),
        loaded: now.loaded,
        travelled: Math.round(saw.travelled),
        top: Math.round(now.top),
        rest: saw.rest,
        moved: saw.moved === null ? null : Math.round(saw.moved),
        turns,
      });
      loaded = now.loaded;
    }
    expect(loads, 'no older page ever loaded, so nothing about loading was proved').toBeGreaterThanOrEqual(1);
    expect(
      worst.every((w) => w.rest >= 0),
      `the pane never came to rest, so nothing could be measured: ${JSON.stringify(worst)}`,
    ).toBe(true);
    return worst;
  }

  test('the row being read stays where it is while older messages arrive above it', async ({ page, request }) => {
    const ground = await makeGround(request, 'pictures', raggedChatSaidWithPictures);
    try {
      const worst = await walksUp(page, ground);
      // eslint-disable-next-line no-console
      console.log('with pictures', JSON.stringify(worst));
      const jumped = worst.filter((w) => w.moved === null || Math.abs(w.moved - WHEEL) > STILL);
      expect(
        jumped,
        `the reader wheeled ${WHEEL}px and the words did not follow: ${JSON.stringify(worst)}`,
      ).toEqual([]);
      const shoved = worst.filter((w) => w.drift > STILL);
      expect(
        shoved,
        `the reader stopped and the words kept moving: ${JSON.stringify(worst)}`,
      ).toEqual([]);
      await page.screenshot({ path: join(SHOTS, 'bw-cdav-scrolled-up.png') });
    } finally {
      await ground.away();
    }
  });

  /**
   * The same walk with nothing in the chat but words.
   *
   * Every pixel of every row is therefore known the moment the row is drawn, so
   * anything that moves the reader here is the chat measuring a row it had only
   * guessed at — not a picture arriving late, which is a different fault on a
   * different card (bw-cdav.3). The rows are as ragged as before: a one-line
   * answer above a forty-line one, so the guesses are wrong by hundreds of
   * pixels and the correction has something to correct.
   */
  test('a row measured for the first time does not shove the reader', async ({ page, request }) => {
    const ground = await makeGround(request, 'words', raggedChatSaid);
    try {
      const worst = await walksUp(page, ground);
      // eslint-disable-next-line no-console
      console.log('words only', JSON.stringify(worst));
      const shoved = worst.filter((w) => w.drift > STILL);
      expect(
        shoved,
        `the reader was not scrolling and the words moved anyway: ${JSON.stringify(worst)}`,
      ).toEqual([]);
      const jumped = worst.filter((w) => w.moved === null || Math.abs(w.moved - WHEEL) > STILL);
      expect(
        jumped,
        `the reader wheeled ${WHEEL}px and the words did not follow: ${JSON.stringify(worst)}`,
      ).toEqual([]);
      await page.screenshot({ path: join(SHOTS, 'bw-cdav-words-only.png') });
    } finally {
      await ground.away();
    }
  });

  /**
   * A long turn of the wheel through rows the chat has never measured.
   *
   * The walk above teleports the pane to the edge of the load and then wheels a
   * screenful, so it says what happens AROUND a page arriving. This says what
   * happens without one: the chat opens on its last page, so every row above the
   * fold is a guess, and the reader wheels up through a thousand pixels of them.
   * Each is measured for the first time as it is drawn, most of them far from
   * the 112px the chat guessed — a forty-line answer is off by five hundred. If
   * the pane is not put back by exactly what the row gained, the words the
   * reader is holding on to slide, and the sum of every one of those slides is
   * the difference between what he asked the wheel for and what he got.
   */
  test('a long wheel through rows never measured gives back exactly what was asked', async ({ page, request }) => {
    const ground = await makeGround(request, 'virgin', raggedChatSaid);
    try {
      await readChat(page, ground);
      const opened = await place(page);
      // Straight up from where the chat opened, with nothing moved by hand.
      // Putting the pane anywhere first draws the rows there and so measures
      // them, and a measured row is exactly what this case must not have: the
      // walk has to be the first time each of these rows is seen.

      // Kept under a paneful. A row wheeled further than the pane is tall
      // leaves it, and a row that is gone cannot be watched — so the walk is
      // made of turns the row survives, each one taking a fresh row at the top.
      const FAR = 400;
      const seen: {
        turn: number;
        drift: number;
        travelled: number;
        rest: number;
        moved: number | null;
        loaded: number;
      }[] = [];
      for (let turn = 0; turn < 6; turn += 1) {
        const saw = await wheelsUpAndReads(page, 10, 900, FAR);
        const now = await place(page);
        seen.push({
          turn,
          drift: Math.round(saw.drift),
          travelled: Math.round(saw.travelled),
          rest: saw.rest,
          moved: saw.moved === null ? null : Math.round(saw.moved),
          loaded: now.loaded,
        });
      }
      // eslint-disable-next-line no-console
      console.log('long wheel through virgin rows', JSON.stringify(seen));
      expect(
        seen.filter((t) => t.loaded !== opened.loaded),
        `an older page arrived, so this is not only about measuring: ${JSON.stringify(seen)}`,
      ).toEqual([]);
      expect(
        seen.filter((t) => t.rest < 0),
        `the pane never came to rest: ${JSON.stringify(seen)}`,
      ).toEqual([]);
      expect(
        seen.filter((t) => t.moved === null || Math.abs(t.moved - FAR) > STILL),
        `the reader wheeled ${FAR}px through rows the chat had only guessed at and the words did not follow: ${JSON.stringify(seen)}`,
      ).toEqual([]);
      expect(
        seen.filter((t) => t.drift > STILL),
        `the reader stopped and the words kept moving: ${JSON.stringify(seen)}`,
      ).toEqual([]);
      await page.screenshot({ path: join(SHOTS, 'bw-cdav-virgin-rows.png') });
    } finally {
      await ground.away();
    }
  });
});
