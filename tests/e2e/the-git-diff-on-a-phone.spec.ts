import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The git diff read on a phone (bw-e3dw.3).
 *
 * The survey (bw-e3dw.1) corrected the item's premise: the diff never scrolled
 * sideways — `diff-table.tsx` is `w-full table-fixed` — so measuring overflow
 * proves nothing here. What it does is shatter: two 169px monospace gutters
 * with `break-all` in them, so every identifier is cut in the middle of itself
 * and read down the screen a syllable at a time. So this case measures
 * READABILITY, in three numbers a person can check against the picture:
 *
 *  * how many gutters of line numbers there are — two columns of numbers means
 *    two columns of code, and neither of them is wide enough to read;
 *  * how wide one line of code is allowed to be;
 *  * how many words in the drawn diff are cut across a line break, which is the
 *    fault itself, counted.
 *
 * Then the same table at 1024px, where side by side is the right answer and
 * must be exactly what it always was.
 *
 * Run: PHONE_DIFF_STAGE=before scripts/workbench-e2e.sh tests/e2e/the-git-diff-on-a-phone.spec.ts
 */

const STAGE = process.env.PHONE_DIFF_STAGE ?? 'now';
const SHOTS = `tests/results/git-diff-phone/${STAGE}`;
const WAIT = 60_000;
const CHAT = 'phone-diff-chat';

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

/**
 * Names long enough that a 169px gutter has to cut them and a full-width line
 * does not — which is the whole difference this case is about.
 */
const BEFORE = `export const theFirstRatherLongIdentifierHere = 1;
export const theSecondRatherLongIdentifierHere = 2;
export const theThirdRatherLongIdentifierHere = 3;
export const theFourthOneAboutToBeDeleted = 4;
export const anUntouchedLineOfContextHere = 5;
`;

const AFTER = `export const theFirstRatherLongIdentifierHere = 1;
export const theSecondRatherLongIdentifierRenamed = 22;
export const theThirdRatherLongIdentifierHere = 3;
export const aBrandNewLineAddedRightHere = 44;
export const anUntouchedLineOfContextHere = 5;
`;

const measured: string[] = [];
function note(what: string): void {
  measured.push(what);
}

function git(at: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: at,
    stdio: 'pipe',
  });
}

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src'), { recursive: true });
  writeFileSync(join(where, 'src', 'main.ts'), BEFORE);

  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Phone Diff');
  git(where, 'config', 'user.email', 'phone-diff@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');

  // One line rewritten, one deleted, one added, the rest context: every kind of
  // row the table can draw, in one file.
  writeFileSync(join(where, 'src', 'main.ts'), AFTER);
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

async function seeTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

/** What the drawn table looks like to a reader, measured off the layout. */
interface Shape {
  /** How many distinct left edges the visible line-number cells sit at. */
  gutters: number;
  /** The widest a single line of code is allowed to be. */
  line: number;
  /** How many text cells are drawn at all. */
  cells: number;
  /** Words of four letters or more that are cut across a line break. */
  cut: number;
  /** How many such words there were to cut. */
  words: number;
  /** A few of the cut ones, spelled out. */
  examples: string[];
  /** How far the document reaches past the window. */
  document: number;
  window: number;
}

async function shapeOf(page: Page): Promise<Shape> {
  return page.evaluate(() => {
    const table = document.querySelector('[data-testid="diff-table"]') as HTMLElement | null;
    if (!table) throw new Error('no diff table was drawn');
    const shown = (el: Element) => getComputedStyle(el).display !== 'none';

    const gutters = new Set<number>();
    let line = 0;
    let cells = 0;
    for (const row of Array.from(table.querySelectorAll('tr'))) {
      if (row.getAttribute('data-diff-kind') === 'gap') continue;
      const tds = Array.from(row.children);
      [tds[0], tds[2]].forEach((td) => {
        if (td && shown(td)) gutters.add(Math.round(td.getBoundingClientRect().left));
      });
      [tds[1], tds[3]].forEach((td) => {
        if (!td || !shown(td)) return;
        cells++;
        line = Math.max(line, Math.round(td.getBoundingClientRect().width));
      });
    }

    // A word cut in half reads as two words. Every run of four letters or more
    // is asked whether the browser drew it on one line or on two.
    const walk = document.createTreeWalker(table, NodeFilter.SHOW_TEXT);
    let cut = 0;
    let words = 0;
    const examples: string[] = [];
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = node.nodeValue ?? '';
      if (!node.parentElement || !shown(node.parentElement)) continue;
      for (const found of text.matchAll(/[A-Za-z][A-Za-z0-9_]{3,}/g)) {
        words++;
        const range = document.createRange();
        range.setStart(node, found.index!);
        range.setEnd(node, found.index! + found[0].length);
        const tops = new Set(Array.from(range.getClientRects()).map((box) => Math.round(box.top)));
        if (tops.size > 1) {
          cut++;
          if (examples.length < 6) examples.push(found[0]);
        }
      }
    }

    return {
      gutters: gutters.size,
      line,
      cells,
      cut,
      words,
      examples,
      document: document.documentElement.scrollWidth,
      window: document.documentElement.clientWidth,
    };
  });
}

test('the git diff on a phone: one column of readable lines, and side by side left alone above the breakpoint', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-phone-diff');
  seed(fixture);

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: fixture, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: 'Renamed one constant and added another.' },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];

  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') !== chat) return;
        const push = (data: unknown) =>
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(data) }),
            }),
          );
        setTimeout(() => push(view), 0);
      }
      close() {
        this.readyState = FixtureSocket.CLOSED;
      }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, view: foldAll(events) });

  await seeTestProjects(page);
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) =>
    route.fulfill({
      json: {
        sessionId: CHAT,
        origin: 'terminal',
        brand: 'claude',
        externalId: 'fixture',
        runningElsewhere: false,
        held: null,
        title: 'A diff read on a phone',
        cwd: fixture,
        beads: [],
      },
    }),
  );

  const project = await fixtureProject(request, 'phone-diff', fixture);
  mkdirSync(SHOTS, { recursive: true });

  try {
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(1500);

    if ((await page.getByTestId('chat-right-rail').getAttribute('data-open')) !== 'true') {
      await page.getByTestId('chat-right-rail-toggle').click();
      await page.waitForTimeout(800);
    }
    await page.getByTestId('chat-git-toggle').click();
    await expect(page.getByTestId('git-view')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(2500);
    await page.getByTestId('git-diff-toggle').click();
    await page.getByTestId('git-diff-view').waitFor({ timeout: WAIT });
    await page.waitForTimeout(2500);
    if ((await page.getByTestId('diff-table').count()) === 0) {
      await page.getByTestId('git-diff-file-toggle').first().click();
      await page.waitForTimeout(2000);
    }
    await expect(page.getByTestId('diff-table').first()).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(500);

    const phone = await shapeOf(page);
    note(
      `the git diff at 390px: ${phone.gutters} gutter(s) of line numbers, ${phone.cells} line cells drawn, ` +
        `the widest line of code is ${phone.line}px; ${phone.cut} of ${phone.words} words are cut across a line break` +
        (phone.examples.length ? ` (${phone.examples.join(', ')})` : '') +
        `; the document is ${phone.document}px in ${phone.window}px`,
    );
    await page.screenshot({ path: `${SHOTS}/01-git-diff-390.png`, animations: 'disabled' });

    // The diff is drawn across the whole 390px, where the transcript is — but
    // the app only draws it while the Git rail is open, and on a phone that
    // rail is a 288px sheet lying over it, so the first picture is 102px of a
    // full-width table. The sheet is a `fixed` overlay and takes no width from
    // the table under it, so hiding it for one frame changes nothing about the
    // layout being measured and shows the table as it is actually laid out.
    const lift = await page.addStyleTag({
      content: '[data-testid="chat-right-rail"],[data-testid="chat-right-rail-scrim"]{display:none !important}',
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/02-git-diff-390-sheet-lifted.png`, animations: 'disabled' });
    await lift.evaluate((el) => el.remove());
    await page.waitForTimeout(300);

    // One gutter, because there is one column of lines behind it.
    expect(phone.gutters, 'the diff still draws two columns of line numbers at 390px').toBe(1);
    // A line of code gets the screen, not a third of it.
    expect(phone.line, 'a line of code is still drawn in a narrow gutter').toBeGreaterThan(300);
    // The fault itself: nothing is cut in the middle of a word.
    expect(phone.cut, `words are still cut in half: ${phone.examples.join(', ')}`).toBe(0);
    // What was already true and must stay true.
    expect(phone.document, 'the diff now scrolls the page sideways').toBeLessThanOrEqual(phone.window + 1);

    // Above the breakpoint, side by side is exactly what it was.
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.waitForTimeout(1200);
    const wide = await shapeOf(page);
    note(
      `the same diff at 1024px: ${wide.gutters} gutter(s), ${wide.cells} line cells drawn, the widest line of code is ${wide.line}px`,
    );
    await page.screenshot({ path: `${SHOTS}/03-git-diff-1024.png`, animations: 'disabled' });
    expect(wide.gutters, 'side by side lost one of its two gutters above the breakpoint').toBe(2);
    expect(wide.cells, 'side by side lost cells above the breakpoint').toBeGreaterThan(phone.cells);
  } finally {
    const report = ['', `======== THE GIT DIFF ON A PHONE (${STAGE}) ========`, '', ...measured.map((one) => `   * ${one}`), ''].join('\n');
    console.log(report);
    writeFileSync(`${SHOTS}/measurements.txt`, report);
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
