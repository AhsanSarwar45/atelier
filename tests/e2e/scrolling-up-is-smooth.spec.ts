import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { discardFixture, makeFixtureProject } from './fixture-board';
import { raggedChatSaidWithPictures, writeLongChat, type LongChat } from './fixture-record';

/**
 * Scrolling up through a long chat, and what it does to the words being read.
 *
 * The chat draws only the rows in the pane and a band around them, and guesses
 * the height of every row it has not drawn yet. A guess is wrong by however far
 * the row it stands for is from an average one — and the moment the real row is
 * drawn and measured, everything below it moves by the difference. If nobody
 * puts the pane back, the reader's own line jumps.
 *
 * Every case here holds the same one line: WHILE THE READER IS NOT SCROLLING,
 * THE ROW HE IS READING DOES NOT MOVE. It is checked against the pane rather
 * than the page, and only in the frames the pane's own offset is standing
 * still — a pane put back by the app moves under a row that does not, and that
 * is the fix working rather than the fault.
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

async function makeGround(request: APIRequestContext): Promise<Ground> {
  const where = join(RUN, 'ragged');
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
    data: { name: 'workbench-smooth', path: project },
  });
  expect(made.status(), await made.text()).toBe(201);
  const listed = (await made.json()) as { id: string };
  const chat = writeLongChat({ cwd: project, sessionId: randomUUID(), held: HELD, said: raggedChatSaidWithPictures });
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
    const state: { key: string; frames: { top: number; row: number | null }[]; raf: number } = {
      key,
      frames: [],
      raf: 0,
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
      __smooth?: { key: string; frames: { top: number; row: number | null }[]; raf: number };
    }).__smooth;
    if (!state) throw new Error('nothing was being watched');
    cancelAnimationFrame(state.raf);
    const frames = state.frames;
    let travelled = 0;
    for (let i = 1; i < frames.length; i += 1) {
      travelled += Math.abs(frames[i]!.top - frames[i - 1]!.top);
    }
    // Where the row came to rest once the wheel was spent: the first frame with
    // three still ones behind it. Everything before that is the reader's own
    // scrolling and the app putting the pane back under him as rows above are
    // measured for the first time — both of which move the pane on purpose.
    let rest = -1;
    for (let i = 3; i < frames.length; i += 1) {
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
async function wheelsUpAndReads(page: Page, steps = 1, quiet = 1500): Promise<Watched> {
  await page.getByTestId('transcript').hover();
  await watch(page);
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, -WHEEL / steps);
    if (i + 1 < steps) await page.waitForTimeout(40);
  }
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
  // nothing touched, and there are two dozen of them.
  test.setTimeout(300_000);

  test('the row being read stays where it is while older messages arrive above it', async ({ page, request }) => {
    const ground = await makeGround(request);
    try {
      await readChat(page, ground);
      const opened = await place(page);
      expect(opened.loaded, 'the chat did not open on a bounded window of its history').toBeGreaterThan(0);
      expect(opened.loaded, 'the chat opened on the whole conversation, so there is nothing to load').toBeLessThan(HELD);

      const worst: {
        step: number;
        drift: number;
        loaded: number;
        travelled: number;
        top: number;
        rest: number;
        moved: number | null;
        turns: number;
      }[] = [];
      let loaded = opened.loaded;
      let loads = 0;
      for (let step = 0; step < 12 && loads < 3; step += 1) {
        await justAboveTheMark(page);
        const saw = await wheelsUpAndReads(page, step % 2 === 0 ? 8 : 1);
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
          turns: step % 2 === 0 ? 8 : 1,
        });
        loaded = now.loaded;
      }
      // eslint-disable-next-line no-console
      console.log('drift per step', JSON.stringify(worst));
      expect(loads, 'no older page ever loaded, so nothing about loading was proved').toBeGreaterThanOrEqual(1);
      expect(
        worst.every((w) => w.rest >= 0),
        `the pane never came to rest, so nothing could be measured: ${JSON.stringify(worst)}`,
      ).toBe(true);
      const jumped = worst.filter(
        (w) => w.moved === null || Math.abs(w.moved - WHEEL) > STILL,
      );
      expect(
        jumped,
        `the reader wheeled ${WHEEL}px and the words did not follow: ${JSON.stringify(worst)}`,
      ).toEqual([]);
      // A row measured for the first time can still shove him after the pane has
      // come to rest; that is a second fault, and bw-cdav.2 is the card that
      // takes the `drift > STILL` reading below out of a comment and into a
      // failure.
      const shoved = worst.filter((w) => w.drift > STILL);
      if (shoved.length > 0) {
        // eslint-disable-next-line no-console
        console.log('shoved after resting (bw-cdav.2)', JSON.stringify(shoved));
      }
      await page.screenshot({ path: join(SHOTS, 'bw-cdav-scrolled-up.png') });
    } finally {
      await ground.away();
    }
  });
});
