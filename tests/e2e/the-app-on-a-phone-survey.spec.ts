import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { bd } from './fixture-board';
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The survey behind the phone epic (bw-e3dw.1).
 *
 * This case does not assert that the app is good on a phone — it is the case
 * that goes and LOOKS. Every screen the app has is driven at 390x844 with touch
 * emulation, and at two more widths besides, and what it finds is written down:
 * what runs off the side, what is smaller than a thumb, what cannot be reached
 * at all. A picture is taken of each. The findings are printed at the end and
 * left in tests/results/phone-survey/, which is what the epic's map is made of.
 *
 * It is deliberately not red on the findings themselves: a survey that stops at
 * the first fault stops surveying, and the six work items under the epic are
 * what fix them. It DOES fail if a screen cannot be reached at all, because
 * then the survey did not happen.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-app-on-a-phone-survey.spec.ts
 */

const SHOTS = 'tests/results/phone-survey';
const MEDIA = join(__dirname, '..', 'fixtures', 'files-preview');
const WAIT = 60_000;
const CHAT = 'phone-survey-chat';

/** A modern phone in the hand, as Playwright's own iPhone 14 preset has it. */
const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

const DEEP = `${Array.from({ length: 40 }, (_, at) => `const aRatherLongIdentifierOnLine${at + 1} = ${at + 1};`).join('\n')}\n`;

const MARKDOWN = `# The project, read on a phone

A paragraph that is long enough to need wrapping when the screen is only three
hundred and ninety pixels wide, which is the whole question this survey asks.

| Column one | Column two | Column three | Column four |
| --- | --- | --- | --- |
| a value | another value | a third value | a fourth value |

\`\`\`ts
const aLineOfCodeThatIsFarTooLongToFitOnAPhoneScreenAndMustDoSomething = 1;
\`\`\`
`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140" viewBox="0 0 200 140">
  <rect x="10" y="10" width="180" height="120" rx="12" fill="#519aba" />
  <circle cx="100" cy="70" r="38" fill="#e37933" />
</svg>
`;

/** Everything the survey writes down, in the order it found it. */
interface Finding {
  screen: string;
  what: string;
}
const findings: Finding[] = [];
const shots: string[] = [];

function note(screen: string, what: string): void {
  findings.push({ screen, what });
}

function git(at: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: at,
    stdio: 'pipe',
  });
}

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src', 'lib'), { recursive: true });
  mkdirSync(join(where, 'assets'), { recursive: true });
  mkdirSync(join(where, 'build'), { recursive: true });
  writeFileSync(join(where, '.gitignore'), 'build/\n');
  writeFileSync(join(where, 'README.md'), MARKDOWN);
  writeFileSync(join(where, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(join(where, 'src', 'lib', 'deep.ts'), DEEP);
  writeFileSync(join(where, 'build', 'out.js'), 'console.log(1)\n');
  writeFileSync(join(where, 'assets', 'logo.svg'), SVG);
  copyFileSync(join(MEDIA, 'shot.png'), join(where, 'assets', 'shot.png'));
  copyFileSync(join(MEDIA, 'clip.mp4'), join(where, 'assets', 'clip.mp4'));

  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Phone Survey');
  git(where, 'config', 'user.email', 'phone-survey@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');

  // A change wide enough that a side-by-side diff has nowhere to put it.
  writeFileSync(
    join(where, 'src', 'main.ts'),
    'export const main = 2;\nexport const alsoRatherLongSoTheDiffHasSomethingWideToDrawOnEachSide = 3;\n',
  );
  writeFileSync(join(where, 'scratch.txt'), 'a file git has never been told about\n');

  // A board of its own, so the Board tab has columns to draw rather than the
  // empty case: the app only believes a project keeps cards when its manifest
  // says so, and only draws them when a database is really there.
  bd(['init', '--prefix', 'ph'], where);
  mkdirSync(join(where, '.atelier'), { recursive: true });
  writeFileSync(
    join(where, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "phone-survey"',
      'use_beads = true',
      'summary = ""',
      '',
      '[git]',
      'completed_work_branch = "main"',
      '',
      '[beads]',
      'issue_id_prefix = "ph"',
      '',
    ].join('\n'),
  );
  const cards = [
    { id: 'ph-1', title: 'A card with a title long enough to need wrapping in a column', status: 'open', issue_type: 'epic', priority: 1 },
    { id: 'ph-2', title: 'Something under way', status: 'in_progress', issue_type: 'task', priority: 1 },
    { id: 'ph-3', title: 'Something finished', status: 'closed', issue_type: 'task', priority: 2 },
    { id: 'ph-4', title: 'Something still waiting', status: 'open', issue_type: 'task', priority: 2 },
  ];
  writeFileSync(join(where, 'seed.jsonl'), cards.map((one) => JSON.stringify(one)).join('\n') + '\n');
  bd(['import', '--input', 'seed.jsonl'], where);
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

/** A picture, its path remembered so the note on the epic can point at it. */
async function shoot(page: Page, name: string): Promise<void> {
  const path = `${SHOTS}/${name}.png`;
  await page.screenshot({ path, animations: 'disabled' });
  shots.push(path);
}

/**
 * Does anything on this screen reach past the right-hand edge?
 *
 * The page itself first, then whichever elements are the ones sticking out, so
 * the note can name the culprit rather than only the symptom.
 */
async function sideways(page: Page, screen: string): Promise<void> {
  const found = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const whole = {
      scroll: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      width,
    };
    /**
     * Is this element only wide because something above it clips or scrolls?
     *
     * A tab strip that pages sideways under a thumb, or a panel drawn shut with
     * `w-0 overflow-hidden`, holds children far to the right on purpose. What
     * this survey is looking for is the thing that pushes the PAGE wide, so the
     * pane that clips is reported once, by itself, and its children are not.
     */
    const heldBySomething = (el: HTMLElement): boolean => {
      for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.overflowX !== 'visible' || style.overflow !== 'visible') return true;
      }
      return false;
    };

    const over: { what: string; right: number; width: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const box = el.getBoundingClientRect();
      if (box.width < 4 || box.height === 0) continue;
      if (box.right <= width + 1) continue;
      // Only the outermost offender: a wide child inside a wide parent is one
      // fault, not two.
      if (el.parentElement && el.parentElement.getBoundingClientRect().right > width + 1) continue;
      if (heldBySomething(el)) continue;
      const id = el.getAttribute('data-testid');
      const classes = String(el.className || '').split(' ').slice(0, 3).join('.');
      over.push({
        what: id ? `[${id}]` : `${el.tagName.toLowerCase()}.${classes}`,
        right: Math.round(box.right),
        width: Math.round(box.width),
      });
    }
    // And the panes that carry their own sideways scrollbar.
    const scrollers: { what: string; scroll: number; shown: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'))) {
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      // A pane a few pixels narrower than its content is a rounding artefact,
      // and a one-pixel box is the composer's hidden mirror, not a screen.
      if (el.clientWidth < 24 || el.scrollWidth - el.clientWidth < 8) continue;
      scrollers.push({
        what: `[${el.getAttribute('data-testid')}]`,
        scroll: el.scrollWidth,
        shown: el.clientWidth,
      });
    }
    return { whole, over: over.slice(0, 8), scrollers: scrollers.slice(0, 8) };
  });

  if (found.whole.scroll > found.whole.width + 1 || found.whole.body > found.whole.width + 1) {
    note(
      screen,
      `THE PAGE SCROLLS SIDEWAYS: the document is ${found.whole.scroll}px wide (body ${found.whole.body}px) in a ${found.whole.width}px window`,
    );
  }
  for (const one of found.over) {
    note(screen, `runs off the right edge: ${one.what} is ${one.width}px wide and ends at x=${one.right}`);
  }
  for (const one of found.scrollers) {
    note(screen, `scrolls sideways inside itself: ${one.what} holds ${one.scroll}px in ${one.shown}px`);
  }
}

/**
 * Which controls on this screen are smaller than a thumb.
 *
 * 44 CSS pixels is the long-standing floor for a touch target; a control under
 * it is one a finger misses.
 */
async function thumbs(page: Page, screen: string): Promise<void> {
  const small = await page.evaluate(() => {
    const seen = new Map<string, { w: number; h: number; n: number }>();
    const pickable = 'button, a[href], [role="button"], [role="tab"], input[type="checkbox"], summary';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(pickable))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      if (box.width >= 44 && box.height >= 44) continue;
      const id =
        el.getAttribute('data-testid') ||
        el.getAttribute('aria-label') ||
        (el.textContent ?? '').trim().slice(0, 24) ||
        el.tagName.toLowerCase();
      const had = seen.get(id);
      if (had) had.n += 1;
      else seen.set(id, { w: Math.round(box.width), h: Math.round(box.height), n: 1 });
    }
    return [...seen.entries()].map(([what, size]) => ({ what, ...size }));
  });
  if (small.length === 0) return;
  const worst = small.sort((a, b) => a.w * a.h - b.w * b.h).slice(0, 10);
  note(
    screen,
    `under 44px to a thumb: ${worst
      .map((one) => `${one.what} ${one.w}x${one.h}${one.n > 1 ? ` (x${one.n})` : ''}`)
      .join(', ')}`,
  );
}

/** Everything asked of one screen at once. */
async function survey(page: Page, screen: string, shot: string): Promise<void> {
  await sideways(page, screen);
  await thumbs(page, screen);
  await shoot(page, shot);
}

test('every screen at a phone width, and what it does there', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-phone-survey');
  seed(fixture);

  const deep = join(fixture, 'src', 'lib', 'deep.ts');
  const said = `Look at ${deep}:7 — and at src/main.ts, which I changed.`;
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: fixture, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: said },
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: [
        {
          sessionId: CHAT,
          externalId: 'fixture',
          brand: 'claude',
          title: 'A chat read on a phone',
          state: 'idle',
          lastActiveAt: new Date(0).toISOString(),
          cwdHint: fixture,
          runningElsewhere: false,
          held: null,
          beads: [],
        },
      ],
    }),
  );
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) =>
    route.fulfill({
      json: {
        sessionId: CHAT,
        origin: 'terminal',
        brand: 'claude',
        externalId: 'fixture',
        runningElsewhere: false,
        held: null,
        title: 'A chat read on a phone',
        cwd: fixture,
        beads: [],
      },
    }),
  );

  const project = await fixtureProject(request, 'phone-survey', fixture);
  mkdirSync(SHOTS, { recursive: true });

  const named = (path: string) =>
    page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/${path}"]`);

  try {
    // 1. The project list, which is the way in.
    await page.goto('/');
    await page.getByTestId('shell').waitFor({ timeout: WAIT });
    await page.waitForTimeout(1500);
    await survey(page, 'the project list (/)', '01-project-list');

    // 2. The chat tab, before a chat is picked.
    await page.goto(`/project?id=${project.id}&tab=chat`);
    // The chat tab's own element is only mounted once a chat is open; before
    // that the screen is the list of chats to restore, and on a phone that list
    // starts pushed off the left edge.
    await page.getByTestId('restore-row').first().waitFor({ state: 'attached', timeout: WAIT });
    const shut = await page.getByTestId('restore-row').first().evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { left: Math.round(box.left), right: Math.round(box.right) };
    });
    note(
      'the chat tab, no chat open',
      `the chat list starts shut: its first row sits from x=${shut.left} to x=${shut.right}, off the left edge, and only the [chat-rail-toggle] brings it back`,
    );
    await survey(page, 'the chat tab, the list shut', '02-chat-tab-list-shut');

    // 3. The chat list, opened the way a thumb opens it.
    await page.getByTestId('chat-rail-toggle').click();
    await expect(page.getByTestId('restore-row').first()).toBeInViewport({ timeout: WAIT });
    await page.waitForTimeout(800);
    const railWidth = await page
      .locator('[data-testid="chat-rail"]')
      .evaluate((el) => el.getBoundingClientRect().width)
      .catch(() => -1);
    const listScrim = (await page.getByTestId('chat-rail-scrim').count()) ? 'drawn' : 'NOT drawn';
    note(
      'the chat tab, the list open',
      `the chat list rail is ${Math.round(railWidth)}px of the 390px window; a scrim is ${listScrim}`,
    );
    await survey(page, 'the chat tab, the list open', '02b-chat-tab-list-open');

    // 4. A chat open.
    await page.getByTestId('restore-row').first().getByTestId('row-name').click();
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(2000);
    await survey(page, 'a chat open', '03-chat-open');

    // 4. The chat's right rail, its Chat view.
    const rightRail = page.getByTestId('chat-right-rail');
    const toggle = page.getByTestId('chat-right-rail-toggle');
    if (await toggle.count()) {
      await toggle.click();
      await expect(rightRail).toBeVisible({ timeout: WAIT });
      await page.waitForTimeout(1000);
      const shape = await rightRail.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return { width: Math.round(box.width), left: Math.round(box.left), position: getComputedStyle(el).position };
      });
      const scrim = (await page.getByTestId('chat-right-rail-scrim').count()) ? 'drawn' : 'NOT drawn';
      note(
        "the chat's right rail (Chat view)",
        `the rail is ${shape.width}px wide, ${shape.position}, starting at x=${shape.left}; a scrim is ${scrim}`,
      );
      await survey(page, "the chat's right rail (Chat view)", '04-right-rail-chat');

      // 5. The same rail, its Git view.
      //
      // The two rail buttons live on the top bar, and the phone sheet is
      // `inset-y-0` — so while the rail is open it lies over both of them and
      // neither can be pressed. The rail has to be shut from inside itself
      // before Git can be asked for, which is a finding in its own right.
      const buried = await page.getByTestId('chat-git-toggle').evaluate((el) => {
        const box = el.getBoundingClientRect();
        const on = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return on?.closest('[data-testid="chat-right-rail"]') !== null;
      });
      if (buried) {
        note(
          "the chat's right rail (Chat view)",
          'the bar buttons that open the rail — [chat-git-toggle] and [chat-right-rail-toggle] — are UNDER the open sheet, because it is inset-y-0 over the whole height including the bar',
        );
      }
      const railClose = page.getByTestId('chat-right-rail-close');
      if (await railClose.count()) await railClose.click();
      await page.waitForTimeout(800);

      const gitToggle = page.getByTestId('chat-git-toggle');
      if (await gitToggle.count()) {
        await gitToggle.click();
        await expect(page.getByTestId('git-view')).toBeVisible({ timeout: WAIT });
        await page.waitForTimeout(3000);
        await survey(page, "the chat's right rail (Git view)", '05-right-rail-git');

        // 6. The diff of a changed file. The rows in the list are links into
        // the Files tab, so the diff is asked for by its own button.
        const diffToggle = page.getByTestId('git-diff-toggle');
        if (await diffToggle.count()) {
          await diffToggle.click();
          await page.getByTestId('git-diff-view').waitFor({ timeout: WAIT });
          await page.waitForTimeout(2500);
          if ((await page.getByTestId('diff-table').count()) === 0) {
            const openFile = page.getByTestId('git-diff-file-toggle').first();
            if (await openFile.count()) {
              await openFile.click();
              await page.waitForTimeout(2000);
            }
          }
          const table = page.getByTestId('diff-table').first();
          if (await table.count()) {
            const wide = await table.evaluate((el) => {
              const cells = el.querySelectorAll('tr')[0]?.children.length ?? 0;
              const text = el.querySelector('td:nth-child(2)') as HTMLElement | null;
              return {
                table: Math.round(el.getBoundingClientRect().width),
                columns: el.querySelectorAll('col').length,
                cells,
                textColumn: text ? Math.round(text.getBoundingClientRect().width) : -1,
                wrapping: text ? getComputedStyle(text).overflowWrap + '/' + getComputedStyle(text).wordBreak : 'none',
              };
            });
            note(
              'the git diff',
              `the diff table is ${wide.table}px wide with ${wide.columns} columns and ${wide.cells} cells to a row: each side's text column is only ${wide.textColumn}px (word-break ${wide.wrapping})`,
            );
          } else {
            note('the git diff', 'no diff table was drawn for the changed file');
          }
          await survey(page, 'the git diff', '06-git-diff');
        } else {
          note("the chat's right rail (Git view)", 'no diff button was drawn, so the diff could not be reached');
        }
      }
      // Shut again, or the sheet lies over the writing box on every screen after.
      const shutAgain = page.getByTestId('chat-right-rail-close');
      if ((await shutAgain.count()) && (await shutAgain.isVisible())) await shutAgain.click();
      await page.waitForTimeout(800);
    }

    // 7. The composer, and the @ menu with a keyboard up.
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(1500);
    const writing = page.getByTestId('composer-frame').locator('.cm-content');
    await writing.click();
    await page.keyboard.type('@src/l');
    await page.waitForTimeout(2000);
    // The completion list is CodeMirror's own autocomplete tooltip, drawn by
    // the editor rather than by a component of ours, so it is found by the
    // class the library gives it.
    const menu = page.locator('.cm-tooltip-autocomplete').first();
    if (await menu.count()) {
      const where = await menu.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return {
          top: Math.round(box.top),
          bottom: Math.round(box.bottom),
          height: Math.round(box.height),
          window: window.innerHeight,
          position: getComputedStyle(el).position,
        };
      });
      note(
        'the composer and its @ menu',
        `the @ menu is ${where.height}px tall, from y=${where.top} to y=${where.bottom} in an ${where.window}px window (${where.position})`,
      );
      // A phone keyboard eats roughly the bottom 336px of a 844px screen.
      const keyboard = 336;
      if (where.bottom > where.window - keyboard) {
        note(
          'the composer and its @ menu',
          `WITH A KEYBOARD UP (${keyboard}px) the menu's bottom at y=${where.bottom} is behind it`,
        );
      }
    } else {
      note('the composer and its @ menu', 'no completion menu appeared for "@src/l"');
    }
    await survey(page, 'the composer and its @ menu', '07-composer-at-menu');

    // The phone's own composer settings dialog, which does already exist.
    const settings = page.getByTestId('mobile-composer-settings');
    note(
      'the composer and its @ menu',
      `a phone-only composer settings button is ${(await settings.count()) ? 'drawn' : 'NOT drawn'}`,
    );
    if (await settings.count()) {
      await page.keyboard.press('Escape');
      await settings.click();
      await page.waitForTimeout(1000);
      await survey(page, "the composer's phone settings dialog", '08-composer-settings-dialog');
      await page.keyboard.press('Escape');
    }

    // 8. The board.
    await page.goto(`/project?id=${project.id}&tab=board`);
    await page.waitForTimeout(4000);
    if (await page.getByTestId('column-scroll').count()) {
      const columns = await page
        .getByTestId('column-scroll')
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
      note('the board', `${columns.length} columns, the first ${columns[0]}px wide, in a 390px window`);
      await survey(page, 'the board', '09-board');
    } else {
      note('the board', 'this project keeps no cards, so the board drew nothing to measure');
      await survey(page, 'the board (no cards)', '09-board-empty');
    }

    // 9. The Files tab: the tree.
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await expect(page.getByTestId('files-tab')).toHaveAttribute('data-root', fixture, { timeout: WAIT });
    await page.waitForTimeout(1500);
    const split = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="files-rail"]') as HTMLElement | null;
      const viewer = document.querySelector('[data-testid="files-viewer"]') as HTMLElement | null;
      const wide = (el: HTMLElement | null) => (el ? Math.round(el.getBoundingClientRect().width) : -1);
      return {
        rail: wide(rail),
        railPosition: rail ? getComputedStyle(rail).position : 'none',
        viewer: wide(viewer),
        window: window.innerWidth,
      };
    });
    note(
      'the Files tab',
      `the tree rail takes ${split.rail}px (${split.railPosition}) and the viewer ${split.viewer}px of a ${split.window}px window`,
    );
    const railToggle = (await page.getByTestId('files-rail-toggle').count()) ? 'drawn' : 'NOT drawn';
    const railScrim = (await page.getByTestId('files-rail-scrim').count()) ? 'drawn' : 'NOT drawn';
    note('the Files tab', `a rail toggle is ${railToggle}; a scrim is ${railScrim}`);
    await survey(page, 'the Files tab, the tree', '10-files-tree');

    // 10. A text file in the viewer.
    await named('src').click();
    await named('src/lib').click();
    await named('src/lib/deep.ts').click();
    await expect
      .poll(() => page.getByTestId('files-viewer').getAttribute('data-file'), { timeout: WAIT })
      .toBe(deep);
    await page.waitForTimeout(1500);
    const codeRoom = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="file-viewer"] .cm-content') as HTMLElement | null;
      if (!el) return null;
      const scroller = el.closest('.cm-scroller') as HTMLElement | null;
      return {
        shown: scroller ? scroller.clientWidth : -1,
        scroll: scroller ? scroller.scrollWidth : -1,
      };
    });
    if (codeRoom) {
      note(
        'the Files tab, a text file',
        `the code pane shows ${codeRoom.shown}px of a ${codeRoom.scroll}px line while the tree holds the rest of the width`,
      );
    }
    await survey(page, 'the Files tab, a text file', '11-files-text');

    // 11. The open-files strip, with several files kept.
    for (const path of ['README.md', 'assets', 'assets/logo.svg', 'assets/shot.png', 'assets/clip.mp4']) {
      await named(path).click();
      await page.waitForTimeout(900);
    }
    const strip = page.getByTestId('open-files-strip');
    if (await strip.count()) {
      const shape = await strip.evaluate((el) => ({
        shown: el.clientWidth,
        scroll: el.scrollWidth,
        overflowX: getComputedStyle(el).overflowX,
        tabs: el.querySelectorAll('[data-testid="open-file"]').length,
      }));
      note(
        'the Files tab, the open-files strip',
        `${shape.tabs} kept files: the strip shows ${shape.shown}px of ${shape.scroll}px (overflow-x: ${shape.overflowX})`,
      );
    } else {
      note('the Files tab, the open-files strip', 'no strip element was found');
    }
    await survey(page, 'the Files tab, the open-files strip', '12-files-strip');

    // 12. Each preview kind.
    for (const [path, name] of [
      ['README.md', '13-preview-markdown'],
      ['assets/logo.svg', '14-preview-svg'],
      ['assets/shot.png', '15-preview-image'],
      ['assets/clip.mp4', '16-preview-video'],
    ] as const) {
      await named(path).click();
      await expect
        .poll(() => page.getByTestId('files-viewer').getAttribute('data-file'), { timeout: WAIT })
        .toBe(`${fixture}/${path}`);
      await page.waitForTimeout(2000);
      await survey(page, `the Files tab, ${path} previewed`, name);
    }

    // 13. A picture under two fingers.
    await named('assets/shot.png').click();
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'image', { timeout: WAIT });
    await page.waitForTimeout(1500);
    const stage = page.getByTestId('file-preview-image-stage');
    if (await stage.count()) {
      const before = await page.getByTestId('file-preview-zoom-level').textContent().catch(() => null);
      const box = (await stage.boundingBox())!;
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      // Playwright has no pinch, so the raw touch events are dispatched — which
      // is what a page listening for them receives from a real hand.
      await stage.evaluate((el, mid) => {
        const finger = (id: number, x: number, y: number) =>
          new Touch({ identifier: id, target: el, clientX: x, clientY: y });
        const fire = (type: string, points: Touch[]) =>
          el.dispatchEvent(
            new TouchEvent(type, {
              touches: points,
              targetTouches: points,
              changedTouches: points,
              bubbles: true,
              cancelable: true,
            }),
          );
        fire('touchstart', [finger(1, mid.x - 30, mid.y), finger(2, mid.x + 30, mid.y)]);
        fire('touchmove', [finger(1, mid.x - 90, mid.y), finger(2, mid.x + 90, mid.y)]);
        fire('touchend', []);
      }, at);
      await page.waitForTimeout(800);
      const after = await page.getByTestId('file-preview-zoom-level').textContent().catch(() => null);
      note(
        'a picture under two fingers',
        `pinching moved the zoom from ${before ?? 'no reading'} to ${after ?? 'no reading'}${
          before === after ? ' — the picture did not answer the pinch' : ''
        }`,
      );
      const moved = await stage.evaluate((el, mid) => {
        const shown = () => {
          const t = document.querySelector('[data-testid="file-preview-image-transform"]') as HTMLElement | null;
          return t ? getComputedStyle(t).transform : 'none';
        };
        const was = shown();
        const finger = (x: number, y: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        const fire = (type: string, points: Touch[]) =>
          el.dispatchEvent(
            new TouchEvent(type, {
              touches: points,
              targetTouches: points,
              changedTouches: points,
              bubbles: true,
              cancelable: true,
            }),
          );
        fire('touchstart', [finger(mid.x, mid.y)]);
        fire('touchmove', [finger(mid.x - 60, mid.y - 40)]);
        fire('touchend', []);
        return { was, now: shown() };
      }, at);
      note(
        'a picture under two fingers',
        `one finger dragging left the transform ${moved.was === moved.now ? 'UNCHANGED' : 'changed'} (${moved.now})`,
      );
      await survey(page, 'a picture under two fingers', '17-picture-touch');
    }

    // 14. The same screens at two other widths, so the breakpoint is chosen
    // from what happens rather than from a round number.
    for (const size of [
      { width: 430, height: 932 },
      { width: 744, height: 1133 },
    ]) {
      const where = `${size.width}x${size.height}`;
      await page.setViewportSize(size);
      await page.waitForTimeout(2000);
      await survey(page, `the Files tab at ${where}`, `18-files-${size.width}`);
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
      await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
      await page.waitForTimeout(2000);
      const chatSplit = await page.evaluate(() => {
        const rail = document.querySelector('[data-testid="chat-rail"]') as HTMLElement | null;
        return rail ? Math.round(rail.getBoundingClientRect().width) : -1;
      });
      note(`a chat at ${where}`, `the chat list rail is ${chatSplit}px wide here`);
      await survey(page, `a chat at ${where}`, `19-chat-${size.width}`);
      await page.goto(`/project?id=${project.id}&tab=files`);
      await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
      await page.waitForTimeout(1500);
    }
  } finally {
    const lines = ['', '======== THE APP ON A PHONE: WHAT THE SURVEY FOUND ========', ''];
    let screen = '';
    for (const found of findings) {
      if (found.screen !== screen) {
        screen = found.screen;
        lines.push(`-- ${screen}`);
      }
      lines.push(`   * ${found.what}`);
    }
    lines.push('', 'Pictures:', ...shots.map((one) => `   ${one}`), '');
    const report = lines.join('\n');
    console.log(report);
    writeFileSync(`${SHOTS}/findings.txt`, report);
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
