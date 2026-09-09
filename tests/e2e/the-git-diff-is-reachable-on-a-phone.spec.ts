import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The git diff can be reached at all on a phone (bw-e3dw.14).
 *
 * bw-e3dw.3 made the table itself readable at 390px, and proved it by hiding
 * the rail for one frame — because the app only drew the diff WHILE the Git
 * rail was open, and on a phone that rail is a 288px fixed sheet at x=102 lying
 * over the very column the diff is drawn in. So a reader saw 102px of a 390px
 * table, and shutting the sheet to see the rest took the diff down with it.
 *
 * This case measures the one number that says whether the diff can be read:
 * how many of the window's 390 columns of pixels actually have the diff on top
 * at them, sampled with `elementFromPoint` rather than trusted. Then it asks
 * for the one press back to the conversation, and finally checks that a wide
 * screen still reads the rail and the diff together and still puts the diff
 * away when the rail is shut.
 *
 * Run: PHONE_DIFF_REACH_STAGE=before scripts/workbench-e2e.sh tests/e2e/the-git-diff-is-reachable-on-a-phone.spec.ts
 */

const STAGE = process.env.PHONE_DIFF_REACH_STAGE ?? 'now';
const SHOTS = `tests/results/git-diff-reach/${STAGE}`;
const WAIT = 60_000;
const CHAT = 'phone-diff-reach-chat';

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

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
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: at, stdio: 'pipe' });
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

/** What a reader can actually see of the diff, asked of the browser pixel by pixel. */
interface Reach {
  /** How wide the table is laid out. */
  table: number;
  /** How many of the window's columns have the diff on top at them. */
  visible: number;
  window: number;
  /** Whatever is lying over the rest, by name. */
  over: string[];
  /** What the rail says about itself. */
  railOpen: string;
}

async function reachOf(page: Page): Promise<Reach> {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-testid="git-diff-pane"]');
    const table = document.querySelector('[data-testid="diff-table"]') as HTMLElement | null;
    if (!pane || !table) throw new Error('no diff was drawn');
    const box = table.getBoundingClientRect();
    const y = Math.round(box.top + Math.min(box.height, window.innerHeight - box.top) / 2);
    let visible = 0;
    const over = new Set<string>();
    for (let x = 0; x < window.innerWidth; x++) {
      const top = document.elementFromPoint(x, y);
      if (top && pane.contains(top)) visible++;
      else if (top) {
        const named = top.closest('[data-testid]');
        over.add(named?.getAttribute('data-testid') ?? top.tagName.toLowerCase());
      }
    }
    const rail = document.querySelector('[data-testid="chat-right-rail"]');
    return {
      table: Math.round(box.width),
      visible,
      window: window.innerWidth,
      over: Array.from(over),
      railOpen: rail?.getAttribute('data-open') ?? 'none',
    };
  });
}

async function openTheDiff(page: Page): Promise<void> {
  if ((await page.getByTestId('chat-right-rail').getAttribute('data-open')) !== 'true') {
    await page.getByTestId('chat-right-rail-toggle').click();
    await page.waitForTimeout(800);
  }
  if ((await page.getByTestId('git-view').count()) === 0) {
    await page.getByTestId('chat-git-toggle').click();
  }
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
  await page.waitForTimeout(600);
}

test('the git diff on a phone is read with nothing over it, and one press brings the conversation back', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-phone-diff-reach');
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
        title: 'A diff reached on a phone',
        cwd: fixture,
        beads: [],
      },
    }),
  );

  const project = await fixtureProject(request, 'phone-diff-reach', fixture);
  mkdirSync(SHOTS, { recursive: true });

  try {
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(1500);

    await openTheDiff(page);

    const phone = await reachOf(page);
    note(
      `the git diff at 390px: the table is laid out ${phone.table}px wide, ` +
        `${phone.visible} of ${phone.window} columns of the window have the diff on top at them` +
        (phone.over.length ? `; what is over the rest: ${phone.over.join(', ')}` : '; nothing is over it') +
        `; the rail says data-open=${phone.railOpen}`,
    );
    await page.screenshot({ path: `${SHOTS}/01-diff-on-a-phone.png`, animations: 'disabled' });

    // The whole point: the sheet has stood aside, and the table under it is the
    // table the reader gets.
    expect(phone.railOpen, 'the Git sheet is still standing over the diff it opened').toBe('false');
    expect(phone.visible, `the diff is still buried under ${phone.over.join(', ')}`).toBeGreaterThanOrEqual(phone.window - 2);

    // And the one press back, which has to be on the bar, because the button
    // that asked for the diff is inside the sheet that just shut.
    const back = page.getByTestId('chat-diff-back');
    await expect(back, 'a phone has no way back to the conversation from the diff').toBeVisible({ timeout: WAIT });
    const backBox = (await back.boundingBox())!;
    note(`the way back on the bar measures ${Math.round(backBox.width)}x${Math.round(backBox.height)}`);
    await back.click();
    await page.waitForTimeout(800);
    await expect(page.getByTestId('git-diff-pane')).toHaveCount(0);
    const transcriptBack = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="transcript"]');
      return Boolean(pane && getComputedStyle(pane.parentElement!).display !== 'none');
    });
    note(`one press on the bar brought the conversation back: ${transcriptBack}`);
    await page.screenshot({ path: `${SHOTS}/02-back-to-the-conversation.png`, animations: 'disabled' });
    expect(transcriptBack, 'the way back left the reader on neither the diff nor the conversation').toBe(true);

    // Above the breakpoint nothing has moved: the rail and the diff are read
    // together, and shutting the rail is still putting the subject away.
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.waitForTimeout(1000);
    await openTheDiff(page);
    const wide = await reachOf(page);
    note(`the same diff at 1024px: the rail says data-open=${wide.railOpen}, the table is ${wide.table}px`);
    await page.screenshot({ path: `${SHOTS}/03-diff-and-rail-at-1024.png`, animations: 'disabled' });
    expect(wide.railOpen, 'a wide screen shut its rail to show the diff').toBe('true');
    await expect(page.getByTestId('chat-diff-back')).toBeHidden();
    await page.getByTestId('chat-right-rail-toggle').click();
    await page.waitForTimeout(800);
    await expect(page.getByTestId('git-diff-pane'), 'shutting the rail on a wide screen no longer puts the diff away').toHaveCount(0);
  } finally {
    const report = ['', `======== THE GIT DIFF REACHED ON A PHONE (${STAGE}) ========`, '', ...measured.map((one) => `   * ${one}`), ''].join('\n');
    console.log(report);
    writeFileSync(`${SHOTS}/measurements.txt`, report);
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
