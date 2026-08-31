import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { makeFixtureProject, PARENT_CARD } from './fixture-board';
import {
  HELPER_AGENT,
  HELPER_SAID,
  longChatSaid,
  writeChatWithHelper,
  writeLongChat,
  type LongChat,
} from './fixture-record';

/**
 * How a chat scrolls.
 *
 * It used to put its own end back in view on every change to the transcript and
 * never ask where the reader was — and an answer arriving rewrites the
 * conversation on every word of it, so reading history while the agent talked
 * meant being dragged back down several times a second (bw-n6yh).
 *
 * Written rather than driven: what is proved here is a reader's place in the
 * pane while messages arrive, and a record another program appends to produces
 * arrivals on demand, one at a time, without paying for an agent or waiting on
 * one. The conversation is long on purpose — a pane the whole chat fits inside
 * has no history to scroll up into and nothing to prove.
 *
 * A place is never checked as a number alone. The window of messages a chat
 * draws is anchored at its end, so it can take rows off its own top as new ones
 * arrive: the pane would not have moved a pixel and the reader would be looking
 * at different words. So every case here names the row being read and asks
 * where THAT row is afterwards.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-scroll.spec.ts
 */

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** Opening a chat off disk is a file read plus a wake. */
const HELLO_MS = 120_000;

/** How close to the end still counts as being at it, in pixels of slack. */
const AT_THE_END = 6;

/** How far a row may drift down the pane and still count as where it was. */
const STAYED = 4;

const RUN = join(__dirname, '..', '.workbench-run-scroll');

/** One row of the conversation, whichever of the two said it. */
const MESSAGE = '[data-testid$="-message"]';

/** Where a case keeps its own project, so the run stays parallel. */
function ground(name: string): string {
  return join(RUN, name);
}

async function projectAt(request: APIRequestContext, name: string, path: string): Promise<{ id: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as { id: string; path: string }[];
  const found = listed.find((p) => p.path === path);
  if (found) return found;
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

interface Ground {
  projectId: string;
  /** Where the project itself is, for a fixture that writes its own record. */
  cwd: string;
  /** Writes one more long conversation into this project. */
  longChat: (held?: number) => LongChat;
  away: () => Promise<void>;
}

/** A project of this case's own, with nothing in it yet. */
async function makeGround(request: APIRequestContext, name: string): Promise<Ground> {
  const where = ground(name);
  const project = join(where, 'project');
  rmSync(where, { recursive: true, force: true });
  mkdirSync(where, { recursive: true });
  makeFixtureProject(project, join(where, 'reporting'));
  const listed = await projectAt(request, `workbench-scroll-${name}`, project);
  const written: LongChat[] = [];
  return {
    projectId: listed.id,
    cwd: project,
    longChat: (held = 120) => {
      const chat = writeLongChat({ cwd: project, sessionId: randomUUID(), held });
      written.push(chat);
      return chat;
    },
    away: async () => {
      written.forEach((c) => c.remove());
      await request.delete(`/api/projects/${listed.id}`);
    },
  };
}

/** Opens the chat page of a project, on its list of past conversations. */
async function openChatList(page: Page, projectId: string): Promise<void> {
  await page.goto(`/project?id=${projectId}&tab=chat`);
  await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: HELLO_MS });
}

/** Clicks one conversation open and waits until the whole of it is on the page. */
async function readChat(page: Page, chat: LongChat): Promise<void> {
  const row = page.locator(`[data-testid="restore-row"][data-external-id="${chat.sessionId}"]`);
  await row.waitFor({ timeout: HELLO_MS });
  await row.getByTestId('row-name').click();
  await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
  // The last thing said is what a chat opens on, so its arrival is the whole
  // conversation being there to scroll.
  await expect(page.getByTestId('transcript').getByText(longChatSaid(chat.held - 1)).first()).toBeVisible({
    timeout: HELLO_MS,
  });
  await settled(page);
}

/** Where the pane is, how far it can go, and how many rows are drawn in it. */
async function place(page: Page): Promise<{ top: number; end: number; rows: number }> {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid="transcript"]') as HTMLElement;
    // Virtualization keeps one height-bearing wrapper in the DOM. Count the
    // complete loaded item window, not only its currently mounted row subset.
    const transcript = document.querySelector('[data-testid="virtual-transcript"]') as HTMLElement | null;
    const rows = Number(transcript?.dataset.totalItems ?? 0);
    return { top: box.scrollTop, end: box.scrollHeight - box.clientHeight, rows };
  });
}

/** How far the end of the conversation is from the bottom of what he can see. */
async function offTheEnd(page: Page): Promise<number> {
  const now = await place(page);
  return now.end - now.top;
}

/** Waits until nothing more is arriving and nothing more is being drawn. */
async function settled(page: Page, still = 400, most = 30_000): Promise<void> {
  const until = Date.now() + most;
  let was = await place(page);
  while (Date.now() < until) {
    await page.waitForTimeout(still);
    const now = await place(page);
    if (now.rows === was.rows && now.end === was.end) return;
    was = now;
  }
}

/** The row the reader has at the top of the pane, and how far down it sits. */
async function reading(page: Page): Promise<{ text: string; at: number }> {
  return page.evaluate((message: string) => {
    const box = document.querySelector('[data-testid="transcript"]') as HTMLElement;
    const seen = box.getBoundingClientRect();
    const row = [...document.querySelectorAll(message)].find((r) => r.getBoundingClientRect().top > seen.top + 8);
    return { text: row?.textContent ?? '', at: row ? row.getBoundingClientRect().top - seen.top : 0 };
  }, MESSAGE);
}

/** Where that same row is now, or nothing if it is no longer drawn at all. */
async function stillAt(page: Page, said: string): Promise<number | null> {
  return page.evaluate(
    ({ message, text }: { message: string; text: string }) => {
      const box = document.querySelector('[data-testid="transcript"]') as HTMLElement;
      const row = [...document.querySelectorAll(message)].find((r) => (r.textContent ?? '') === text);
      return row ? row.getBoundingClientRect().top - box.getBoundingClientRect().top : null;
    },
    { message: MESSAGE, text: said },
  );
}

/** The reader takes the pane somewhere himself, wheel and all. */
async function readerScrolls(page: Page, by: number): Promise<void> {
  await page.getByTestId('transcript').hover();
  await page.mouse.wheel(0, by);
  await page.waitForTimeout(300);
  if (by < 0) {
    expect(await offTheEnd(page), 'the wheel did not take the pane off the end of the conversation').toBeGreaterThan(
      200,
    );
  }
}

/** Whether a message is inside the part of the pane the reader can see. */
async function inView(page: Page, text: string): Promise<boolean> {
  return page.evaluate(
    ({ message, said }: { message: string; said: string }) => {
      const box = document.querySelector('[data-testid="transcript"]') as HTMLElement;
      const row = [...document.querySelectorAll(message)].find((e) => (e.textContent ?? '').includes(said));
      if (!row) return false;
      const seen = box.getBoundingClientRect();
      const mine = row.getBoundingClientRect();
      return mine.bottom <= seen.bottom + 2 && mine.bottom >= seen.top;
    },
    { message: MESSAGE, said: text },
  );
}

/**
 * Where the way back is drawn.
 *
 * It floats over the conversation's own bottom corner, which is where every
 * chat draws it. For a while it had a strip of its own below the conversation
 * instead, to keep it off the last line of text (bw-n6yh.9); a whole row of
 * empty screen between the conversation and the box you type in costs more than
 * the corner of one line it sits over, and the manager asked for it floating
 * (bw-n6yh.13). So what is checked is that it floats, and that it floats at the
 * conversation's own right edge rather than out in the margin of a wide window.
 */
async function floats(page: Page): Promise<{ below: number; above: number; margin: number }> {
  return page.evaluate(() => {
    const pill = document.querySelector('[data-testid="back-to-now"]')?.getBoundingClientRect();
    const pane = document.querySelector('[data-testid="transcript"]')?.getBoundingClientRect();
    if (!pill || !pane) return { below: 9999, above: 9999, margin: 9999 };
    return {
      // How far past the bottom of the conversation it hangs, and past its top.
      below: pill.bottom - pane.bottom,
      above: pane.top - pill.top,
      margin: pane.right - pill.right,
    };
  });
}

/**
 * How far the conversation can be pushed sideways, and by what.
 *
 * A pane that scrolls up and down scrolls sideways too the moment anything in
 * it reaches past its own right edge, and the reader gets a page that slides
 * under him while he reads.
 */
async function sideways(page: Page, testId = 'transcript'): Promise<{ by: number; widest: string }> {
  return page.evaluate((paneId) => {
    const pane = document.querySelector(`[data-testid="${paneId}"]`) as HTMLElement;
    const edge = pane.getBoundingClientRect().left + pane.clientWidth - parseFloat(getComputedStyle(pane).paddingRight);
    let worst = { past: 0, what: 'nothing' };
    const look = (el: Element) => {
      const box = el.getBoundingClientRect();
      const past = box.right - edge;
      // Only what is laid out wide, not what scrolls inside its own frame: a
      // block of code is meant to have its own bar.
      if (box.width > 0 && past > worst.past && getComputedStyle(el).overflowX === 'visible') {
        worst = {
          past,
          what: `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? '-'}] ${(el.className?.toString?.() ?? '').slice(0, 90)}`,
        };
      }
      for (const child of el.children) look(child);
    };
    const rows = pane.querySelector('[data-testid="transcript-rows"]') ?? pane;
    look(rows);
    return { by: pane.scrollWidth - pane.clientWidth, widest: `${worst.what} (${worst.past.toFixed(0)}px past)` };
  }, testId);
}

/** How much dead screen sits between the conversation and the box you type in. */
async function gap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-testid="transcript"]')?.getBoundingClientRect();
    const box = document.querySelector('[data-testid="composer-frame"]')?.getBoundingClientRect();
    if (!pane || !box) return -1;
    return box.top - pane.bottom;
  });
}

/**
 * Says `many` more things into the record, and waits for the transcript to
 * contain them all.
 *
 * When the reader is in history the newest rows intentionally are not mounted:
 * the virtualizer only draws the viewport and its overscan.  The complete
 * loaded window is exposed on the height-bearing transcript instead, so wait
 * on that count here.  The cases below separately prove that the newest row is
 * mounted and visible after returning to the end.
 */
async function arrives(page: Page, chat: LongChat, many: number): Promise<string> {
  const before = (await place(page)).rows;
  let last = '';
  for (let n = 0; n < many; n += 1) last = chat.says();
  await expect
    .poll(async () => (await place(page)).rows, { timeout: HELLO_MS })
    .toBeGreaterThanOrEqual(before + many);
  await settled(page);
  return last;
}

/** Every frame the pane is drawn in, from the moment the page begins loading. */
async function watchEveryFrame(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: { top: number; end: number }[] = [];
    (window as unknown as { seen: typeof seen }).seen = seen;
    const look = () => {
      const box = document.querySelector('[data-testid="transcript"]');
      if (box instanceof HTMLElement) {
        (window as unknown as { seen: typeof seen }).seen.push({
          top: box.scrollTop,
          end: box.scrollHeight - box.clientHeight,
        });
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}

/** What was seen since the last look, and the counting starts again. */
async function framesSince(page: Page): Promise<{ top: number; end: number }[]> {
  return page.evaluate(() => {
    const held = window as unknown as { seen: { top: number; end: number }[] };
    const was = held.seen;
    held.seen = [];
    return was;
  });
}

/** Every frame worth judging was drawn at the end of the conversation. */
function neverAwayFromTheEnd(frames: { top: number; end: number }[], what: string): void {
  const deep = frames.filter((f) => f.end > 200);
  expect(deep.length, `the conversation never had a height worth scrolling (${what})`).toBeGreaterThan(3);
  const worst = Math.max(...deep.map((f) => f.end - f.top));
  if (worst > AT_THE_END) {
    const off = deep.map((f, at) => ({ at, off: f.end - f.top, end: f.end })).filter((f) => f.off > AT_THE_END);
    console.log(`${what}: ${off.length} of ${deep.length} frames off the end`, JSON.stringify(off.slice(0, 12)));
  }
  expect(worst, `the pane was drawn away from the end of the conversation (${what})`).toBeLessThanOrEqual(AT_THE_END);
}

test.describe('how a chat scrolls', () => {
  // Opening a hundred-message conversation off disk, then waiting on messages
  // arriving one at a time, is minutes rather than the default half-minute.
  //
  // One at a time, too: five conversations opening at once are five whole-record
  // reads on the sidecar's one thread, and a run where all five simply never
  // opened is the answer that gives (chat-agents.spec.ts does the same).
  test.describe.configure({ mode: 'default', timeout: 300_000 });

  /**
   * A page resolves its project by filtering the plain project list in the
   * browser, and a fixture project is marked as a test one so it stays off the
   * owner's dashboard — which would leave it invisible to its own tab as well,
   * and no chat screen would ever mount. So this page's own asking for that
   * list asks for test projects too, the same rewrite the report cases use
   * (report-answer.spec.ts).
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

  test('reloads the durable chat list without waiting for provider discovery', async ({ page, request }) => {
    const kept = await makeGround(request, 'list-fast');
    try {
      const chat = kept.longChat();
      await openChatList(page, kept.projectId);
      // Opening once imports the external offer into the shared durable store.
      // A reload must draw that stored row before the slower provider index is
      // reconciled, which is the cold-list path the owner waits on.
      await readChat(page, chat);

      const began = performance.now();
      await page.reload();
      await page.locator(`[data-testid="restore-row"][data-external-id="${chat.sessionId}"]`).waitFor();
      const elapsed = performance.now() - began;
      expect(elapsed, `the saved chat list took ${elapsed.toFixed(1)}ms to return`).toBeLessThan(1_000);
    } finally {
      await kept.away();
    }
  });

  /**
   * A chat is read from its end, and it is there before the first frame: a pane
   * that starts at the top and is moved afterwards shows the history flying
   * past, which is a page loading rather than a conversation opening. Switching
   * to another conversation is that same moment again, and is checked with it.
   */
  test('opens at the end, and was never drawn anywhere else', async ({ page, request }) => {
    const kept = await makeGround(request, 'opens');
    try {
      const first = kept.longChat();
      const second = kept.longChat();
      await watchEveryFrame(page);

      await openChatList(page, kept.projectId);
      await readChat(page, first);
      neverAwayFromTheEnd(await framesSince(page), 'opening');
      expect(await inView(page, longChatSaid(first.held - 1)), 'the newest message is not on the screen').toBe(true);
      await page.screenshot({ path: `${SHOTS}/chat-scroll-opens-at-the-end.png` });

      await readChat(page, second);
      neverAwayFromTheEnd(await framesSince(page), 'switching');
      expect(await inView(page, longChatSaid(second.held - 1)), 'the other chat did not open at its end').toBe(true);
    } finally {
      await kept.away();
    }
  });

  /**
   * The whole of the fault this job was opened for: reading history while the
   * conversation grows. The row being read must not move, and must not be taken
   * off the page either (bw-n6yh.2, bw-n6yh.7).
   */
  test('leaves the reader alone while he is reading history', async ({ page, request }) => {
    const kept = await makeGround(request, 'history');
    try {
      const chat = kept.longChat();
      await openChatList(page, kept.projectId);
      await readChat(page, chat);

      await readerScrolls(page, -1200);
      const was = await place(page);
      const read = await reading(page);
      expect(was.end - was.top, 'the wheel did not move the pane off the end').toBeGreaterThan(200);
      expect(read.text, 'nothing was being read at the top of the pane').not.toBe('');

      await arrives(page, chat, 20);
      const now = await place(page);
      expect(
        Math.abs(now.top - was.top),
        'twenty messages arriving moved the pane the reader was reading in',
      ).toBeLessThanOrEqual(2);
      const after = await stillAt(page, read.text);
      expect(after, 'the row that was being read was taken off the page').not.toBeNull();
      expect(
        Math.abs((after ?? 0) - read.at),
        'twenty messages arriving moved the words the reader was reading',
      ).toBeLessThanOrEqual(STAYED);
      await page.screenshot({ path: `${SHOTS}/chat-scroll-reading-history.png` });

      // And back at the end it follows again, message by message.
      await page.getByTestId('back-to-now').click();
      await expect.poll(() => offTheEnd(page), { timeout: 10_000 }).toBeLessThanOrEqual(AT_THE_END);
      for (let n = 0; n < 3; n += 1) {
        const said = await arrives(page, chat, 1);
        expect(await inView(page, said), `the message that arrived was not in view (${n})`).toBe(true);
      }
    } finally {
      await kept.away();
    }
  });

  /**
   * Growth that adds no message: a picture waiting to be sent grows the box he
   * types in under the conversation, and the window itself changes size. Both
   * move the end without a word being said, and both must leave him wherever he
   * is looking — at the end if that is where he was, and on his own row if not.
   */
  test('holds the end through growing that adds no message', async ({ page, request }) => {
    const kept = await makeGround(request, 'growing');
    try {
      const chat = kept.longChat();
      await openChatList(page, kept.projectId);
      await readChat(page, chat);

      // A picture waiting to go: the tray under the typing box appears and the
      // conversation above it loses that much room.
      await page.getByTestId('image-input').setInputFiles({
        name: 'dot.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
      await expect(page.getByTestId('attachment-thumb')).toBeVisible();
      await page.waitForTimeout(400);
      expect(
        await offTheEnd(page),
        'the typing box growing under the conversation left its end off the screen',
      ).toBeLessThanOrEqual(AT_THE_END);

      await page.setViewportSize({ width: 1100, height: 620 });
      await page.waitForTimeout(400);
      expect(await offTheEnd(page), 'the window resizing left the end off the screen').toBeLessThanOrEqual(AT_THE_END);
      // And it is still FOLLOWING the end, not merely sitting at it: a resize
      // moves the pane without the reader touching anything, and reading that
      // as him scrolling away is how the chat quietly stopped following.
      await expect(
        page.getByTestId('back-to-now'),
        'the window resizing made the chat let go of its own end',
      ).toHaveAttribute('data-shown', 'no');
      expect(
        await inView(page, longChatSaid(chat.held - 1)),
        'the end was in the right place and the newest message still was not on the screen',
      ).toBe(true);
      await page.screenshot({ path: `${SHOTS}/chat-scroll-growing.png` });

      // And none of it moves a reader who is not at the end.
      await readerScrolls(page, -1200);
      const read = await reading(page);
      expect(read.text, 'nothing was being read at the top of the pane').not.toBe('');
      await page.getByTestId('attachment-remove').click();
      await page.waitForTimeout(400);
      const after = await stillAt(page, read.text);
      expect(after, 'the row that was being read was taken off the page').not.toBeNull();
      expect(
        Math.abs((after ?? 0) - read.at),
        'the typing box shrinking dragged a reader who was reading history',
      ).toBeLessThanOrEqual(STAYED);
    } finally {
      await kept.away();
    }
  });

  /**
   * The way back. A chat that quietly stops following its own end has to say so,
   * or a reader who scrolled up has no way of knowing anything more was said.
   */
  test('says what arrived while he was away, and takes one click back to now', async ({ page, request }) => {
    const kept = await makeGround(request, 'back');
    try {
      const chat = kept.longChat();
      await openChatList(page, kept.projectId);
      await readChat(page, chat);

      const back = page.getByTestId('back-to-now');
      await expect(back, 'the way back was drawn while the end was already in view').toHaveAttribute(
        'data-shown',
        'no',
      );

      await readerScrolls(page, -1200);
      await expect(back).toHaveAttribute('data-shown', 'yes');
      await expect(back, 'nothing had arrived, and it counted something').toHaveAttribute('data-missed', '0');

      const said = await arrives(page, chat, 7);
      await expect(back).toHaveAttribute('data-missed', '7');
      await expect(page.getByTestId('back-to-now-count')).toHaveText('7');
      await page.screenshot({ path: `${SHOTS}/chat-scroll-back-to-now.png` });
      const drawn = await floats(page);
      const where = `bottom ${drawn.below.toFixed(0)}, top ${drawn.above.toFixed(0)}, right ${drawn.margin.toFixed(0)}`;
      expect(drawn.below, `the way back hangs below the conversation (${where})`).toBeLessThanOrEqual(1);
      expect(drawn.above, `the way back is drawn above the conversation (${where})`).toBeLessThanOrEqual(1);
      expect(drawn.below, `the way back is not at the conversation's bottom corner (${where})`).toBeGreaterThan(-80);
      expect(drawn.margin, `the way back floats out in the window margin (${where})`).toBeLessThan(40);
      expect(drawn.margin, `the way back is drawn off the right of the conversation (${where})`).toBeGreaterThan(-1);
      expect(
        await gap(page),
        'a row of empty screen sits between the conversation and the box you type in',
      ).toBeLessThan(40);

      await back.click();
      await expect.poll(() => offTheEnd(page), { timeout: 10_000 }).toBeLessThanOrEqual(AT_THE_END);
      expect(await inView(page, said), 'the newest message is not on the screen').toBe(true);
      await expect(back).toHaveAttribute('data-shown', 'no');
      await expect(back).toHaveAttribute('data-missed', '0');
    } finally {
      await kept.away();
    }
  });

  /**
   * Older messages arrive ABOVE where the reader is looking, and a pane that
   * does nothing about it slides the words he is reading down the screen by
   * however tall they are.
   */
  test('leaves the read row where it was when older messages arrive', async ({ page, request }) => {
    const kept = await makeGround(request, 'older');
    try {
      const chat = kept.longChat();
      await openChatList(page, kept.projectId);
      await readChat(page, chat);

      const before = await place(page);
      // All the way up, which is where the older ones are asked for.
      await page.getByTestId('transcript').hover();
      for (let n = 0; n < 12; n += 1) await page.mouse.wheel(0, -1500);
      await page.waitForTimeout(600);
      const read = await reading(page);
      expect(read.text, 'nothing was being read at the top of the pane').not.toBe('');
      await expect
        .poll(async () => (await place(page)).rows, { message: 'no older messages ever arrived', timeout: HELLO_MS })
        .toBeGreaterThan(before.rows);
      await settled(page);

      // Reaching the head repeatedly eventually reaches the first turn; no
      // invisible zero-height sentinel or one-shot latch may impose a ceiling.
      for (let n = 0; n < 12 && (await page.getByText(longChatSaid(0), { exact: true }).count()) === 0; n += 1) {
        await page.mouse.wheel(0, -1500);
        await page.waitForTimeout(250);
      }
      await expect(page.getByText(longChatSaid(0), { exact: true })).toHaveCount(1);
      await expect(page.getByTestId('transcript').locator('[data-testid="user-message"]')).not.toHaveCount(0);

      const after = await stillAt(page, read.text);
      expect(after, 'the row that was being read is no longer drawn').not.toBeNull();
      expect(
        Math.abs((after ?? 0) - read.at),
        'older messages arriving pushed the row the reader was on down the screen',
      ).toBeLessThanOrEqual(STAYED);
      await page.screenshot({ path: `${SHOTS}/chat-scroll-older-messages.png` });
    } finally {
      await kept.away();
    }
  });

  /**
   * A conversation only scrolls one way. A helper's words now live in the
   * helper's own pane rather than burying the manager's turn. That pane still
   * has to contain every full-width message inside its right edge; otherwise
   * the reader gets a page that slides under him while he reads (bw-n6yh.14,
   * bw-pukk.1).
   */
  test('never scrolls sideways, whoever said the message', async ({ page, request }) => {
    const kept = await makeGround(request, 'wide');
    const written = writeChatWithHelper({ cwd: kept.cwd, sessionId: randomUUID(), card: PARENT_CARD });
    try {
      await openChatList(page, kept.projectId);
      const listed = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
      await listed.waitFor({ timeout: HELLO_MS });
      await listed.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
      // Finished helpers stay behind one explicit control. Open the helper's
      // row and measure the pane where its complete conversation now belongs.
      await page.getByTestId('toggle-stopped-agents').click();
      const helper = page.locator(`[data-testid="sent-away-row"][data-agent="${HELPER_AGENT}"]`);
      await expect(helper).toBeVisible({ timeout: HELLO_MS });
      await helper.getByTestId('sent-away-open').click();
      await expect(page.getByTestId('agent-view-said')).toContainText(HELPER_SAID, { timeout: HELLO_MS });
      await settled(page);

      const off = await sideways(page, 'agent-view-said');
      expect(off.by, `the helper conversation scrolls ${off.by}px sideways; widest is ${off.widest}`).toBe(0);
    } finally {
      written.remove();
      await kept.away();
    }
  });
});
