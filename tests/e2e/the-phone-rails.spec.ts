import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The two rails of the app on a phone (bw-e3dw.9, bw-e3dw.2).
 *
 * The survey (bw-e3dw.1) went and looked; this case is what the two fixes are
 * proved by. It drives the real app at 390x844 with touch and asks three
 * things:
 *
 *  * with a chat's right rail open, are the bar buttons that opened it still
 *    pressable — is the Git view one tap away rather than two;
 *  * at 700px, does ONE breakpoint decide, so the rail is either a column or a
 *    sheet and never a sheet that defaulted itself open over the reading;
 *  * on the Files tab, is the tree an overlay with a scrim and a toggle, and
 *    does the viewer get the whole width.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-phone-rails.spec.ts
 */

const STAGE = process.env.PHONE_RAILS_STAGE ?? 'now';
const SHOTS = `tests/results/phone-rails/${STAGE}`;
const MEDIA = join(__dirname, '..', 'fixtures', 'files-preview');
const WAIT = 60_000;
const CHAT = 'phone-rails-chat';

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

const MARKDOWN = `# The project, read on a phone

A paragraph that is long enough to need wrapping when the screen is only three
hundred and ninety pixels wide, which is the whole question this case asks.
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
  mkdirSync(join(where, 'src', 'lib'), { recursive: true });
  mkdirSync(join(where, 'assets'), { recursive: true });
  writeFileSync(join(where, 'README.md'), MARKDOWN);
  writeFileSync(join(where, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(
    join(where, 'src', 'lib', 'deep.ts'),
    Array.from({ length: 40 }, (_, at) => `const aRatherLongIdentifierOnLine${at + 1} = ${at + 1};`).join('\n') + '\n',
  );
  copyFileSync(join(MEDIA, 'shot.png'), join(where, 'assets', 'shot.png'));

  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Phone Rails');
  git(where, 'config', 'user.email', 'phone-rails@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');
  writeFileSync(join(where, 'scratch.txt'), 'a file git has never been told about\n');
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

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' });
}

/** Is the control at its own centre the thing a finger would actually hit? */
async function pressable(page: Page, id: string): Promise<boolean> {
  const button = page.getByTestId(id);
  if ((await button.count()) === 0) return false;
  return button.first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    const on = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return on !== null && (el.contains(on) || on.contains(el));
  });
}

/** Put the Files tab's tree where the next step needs it, however it opened. */
async function tree(page: Page, want: 'open' | 'shut'): Promise<void> {
  const toggle = page.getByTestId('files-rail-toggle');
  if ((await toggle.count()) === 0) return;
  const rail = page.getByTestId('files-rail');
  if (((await rail.getAttribute('data-open')) === 'true') !== (want === 'open')) {
    await toggle.click();
    await page.waitForTimeout(700);
  }
}

/** How far past the right edge of the window anything reaches. */
async function sideways(page: Page): Promise<{ page: number; window: number; over: string[] }> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const over: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'))) {
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      if (el.clientWidth < 24 || el.scrollWidth - el.clientWidth < 8) continue;
      over.push(`[${el.getAttribute('data-testid')}] holds ${el.scrollWidth}px in ${el.clientWidth}px`);
    }
    return { page: document.documentElement.scrollWidth, window: width, over: over.slice(0, 8) };
  });
}

test('the phone rails: the bar stays reachable, one breakpoint decides, and the tree is an overlay', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-phone-rails');
  seed(fixture);

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: fixture, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: 'A short answer, read on a phone.' },
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
        title: 'A chat read on a phone',
        cwd: fixture,
        beads: [],
      },
    }),
  );

  const project = await fixtureProject(request, 'phone-rails', fixture);
  mkdirSync(SHOTS, { recursive: true });

  const named = (path: string) =>
    page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/${path}"]`);

  try {
    // ---- bw-e3dw.9, first fault: an open sheet over the bar that opened it.
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(1500);

    if ((await page.getByTestId('chat-right-rail').getAttribute('data-open')) !== 'true') {
      await page.getByTestId('chat-right-rail-toggle').click();
    }
    await expect(page.getByTestId('chat-right-rail')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(800);
    const railBox = await page.getByTestId('chat-right-rail').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { top: Math.round(box.top), width: Math.round(box.width), position: getComputedStyle(el).position };
    });
    const barBottom = await page
      .getByTestId('tab-bar')
      .evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
    const gitReachable = await pressable(page, 'chat-git-toggle');
    const toggleReachable = await pressable(page, 'chat-right-rail-toggle');
    note(
      `chat right rail open at 390px: ${railBox.width}px ${railBox.position} starting at y=${railBox.top}, the bar ends at y=${barBottom}; ` +
        `[chat-git-toggle] ${gitReachable ? 'IS' : 'is NOT'} pressable, [chat-right-rail-toggle] ${toggleReachable ? 'IS' : 'is NOT'} pressable`,
    );
    await shoot(page, '01-chat-right-rail-open');
    expect(gitReachable, 'the sheet is over [chat-git-toggle]').toBe(true);
    expect(toggleReachable, 'the sheet is over [chat-right-rail-toggle]').toBe(true);
    expect(railBox.top, 'the sheet starts above the bottom of the bars').toBeGreaterThanOrEqual(barBottom - 1);

    // The whole point: Git from Chat in one tap, without shutting the sheet.
    if (gitReachable) {
      await page.getByTestId('chat-git-toggle').click();
      await expect(page.getByTestId('git-view')).toBeVisible({ timeout: WAIT });
      await page.waitForTimeout(2500);
      note('with the sheet open, one tap on [chat-git-toggle] reached the Git view');
      await shoot(page, '02-chat-git-in-one-tap');
    } else {
      note('the Git view could NOT be reached without shutting the sheet first');
    }

    // The chat list's own sheet, from the other edge.
    if ((await page.getByTestId('chat-right-rail').getAttribute('data-open')) === 'true') {
      const close = page.getByTestId('chat-right-rail-close');
      if ((await close.count()) && (await close.isVisible())) await close.click();
      else await page.getByTestId('chat-right-rail-scrim').click();
      await page.waitForTimeout(700);
    }
    await page.getByTestId('chat-rail-toggle').click();
    await page.waitForTimeout(800);
    note(
      `chat list sheet open at 390px: [chat-rail-toggle] ${
        (await pressable(page, 'chat-rail-toggle')) ? 'IS' : 'is NOT'
      } pressable`,
    );
    expect(await pressable(page, 'chat-rail-toggle'), 'the chat list sheet is over its own toggle').toBe(true);
    await shoot(page, '03-chat-list-sheet-open');
    // On the bare strip of scrim the 288px sheet leaves, not its centre.
    await page.mouse.click(370, 500);
    await page.waitForTimeout(700);

    // ---- bw-e3dw.9, second fault: two answers to "is this a phone" at 700px.
    await page.setViewportSize({ width: 700, height: 900 });
    await page.evaluate(() => localStorage.clear());
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(2000);
    const at700 = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="chat-right-rail"]') as HTMLElement | null;
      const scrim = document.querySelector('[data-testid="chat-right-rail-scrim"]') as HTMLElement | null;
      return {
        open: rail?.getAttribute('data-open') ?? 'none',
        width: rail ? Math.round(rail.getBoundingClientRect().width) : -1,
        position: rail ? getComputedStyle(rail).position : 'none',
        scrimShown: scrim ? getComputedStyle(scrim).display !== 'none' : false,
      };
    });
    note(
      `at 700px with nothing remembered: the right rail is data-open=${at700.open}, ${at700.width}px, ${at700.position}` +
        `; its scrim is ${at700.scrimShown ? 'in the layout' : 'hidden'}`,
    );
    if (at700.position === 'fixed' && at700.open === 'true') {
      note('AT 700px THE RAIL DEFAULTS OPEN AND IS DRAWN AS A SHEET OVER THE READING — two answers, not one');
    }
    // One answer, not two: a rail that is drawn as a sheet is a rail that did
    // not default itself open.
    expect(at700.position === 'fixed' && at700.open === 'true', 'two answers at 700px').toBe(false);
    await shoot(page, '04-chat-at-700');

    // ---- bw-e3dw.2: the Files tab at 390px.
    await page.setViewportSize(PHONE);
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await expect(page.getByTestId('files-tab')).toHaveAttribute('data-root', fixture, { timeout: WAIT });
    await page.waitForTimeout(1500);
    const split = await page.evaluate(() => {
      const wide = (id: string) => {
        const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
        return el ? Math.round(el.getBoundingClientRect().width) : -1;
      };
      const rail = document.querySelector('[data-testid="files-rail"]') as HTMLElement | null;
      return {
        rail: wide('files-rail'),
        railPosition: rail ? getComputedStyle(rail).position : 'none',
        railLeft: rail ? Math.round(rail.getBoundingClientRect().left) : -1,
        railWasOpen: rail?.getAttribute('data-open') ?? 'none',
        viewer: wide('files-viewer'),
        window: window.innerWidth,
      };
    });
    const toggleDrawn = (await page.getByTestId('files-rail-toggle').count()) > 0;
    const scrimDrawn = (await page.getByTestId('files-rail-scrim').count()) > 0;
    note(
      `Files tab at 390px, as it opens: the rail is ${split.rail}px (${split.railPosition}, left=${split.railLeft}, ` +
        `data-open=${split.railWasOpen}), the viewer ${split.viewer}px of ${split.window}px; a toggle is ${
          toggleDrawn ? 'drawn' : 'NOT drawn'
        }, a scrim is ${scrimDrawn ? 'drawn' : 'NOT drawn'}`,
    );

    // The tree put away, which is what a file is read behind.
    await tree(page, 'shut');
    const shut = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="files-rail"]') as HTMLElement | null;
      const viewer = document.querySelector('[data-testid="files-viewer"]') as HTMLElement | null;
      return {
        left: rail ? Math.round(rail.getBoundingClientRect().left) : -1,
        viewer: viewer ? Math.round(viewer.getBoundingClientRect().width) : -1,
      };
    });
    note(`Files tab at 390px, tree shut: the rail sits at x=${shut.left} and the viewer takes ${shut.viewer}px of 390px`);
    const overflow = await sideways(page);
    note(
      `Files tab at 390px: the document is ${overflow.page}px in ${overflow.window}px${
        overflow.over.length ? `; ${overflow.over.join('; ')}` : '; nothing scrolls sideways'
      }`,
    );
    expect(toggleDrawn, 'no way to open the tree on a phone').toBe(true);
    expect(scrimDrawn, 'no scrim behind the tree on a phone').toBe(true);
    expect(shut.viewer, 'the tree still takes width from the viewer').toBe(split.window);
    expect(overflow.page, 'the Files tab scrolls sideways').toBeLessThanOrEqual(overflow.window + 1);
    expect(overflow.over, 'a pane on the Files tab scrolls sideways inside itself').toEqual([]);
    await shoot(page, '05-files-tree-shut');

    // The tree as an overlay, opened the way a thumb opens it.
    {
      await tree(page, 'open');
      const open = await page.evaluate(() => {
        const rail = document.querySelector('[data-testid="files-rail"]') as HTMLElement | null;
        const viewer = document.querySelector('[data-testid="files-viewer"]') as HTMLElement | null;
        return {
          rail: rail ? Math.round(rail.getBoundingClientRect().width) : -1,
          left: rail ? Math.round(rail.getBoundingClientRect().left) : -1,
          position: rail ? getComputedStyle(rail).position : 'none',
          viewer: viewer ? Math.round(viewer.getBoundingClientRect().width) : -1,
        };
      });
      note(
        `Files tab at 390px, tree open: the rail is ${open.rail}px ${open.position} at x=${open.left} OVER a viewer still ${open.viewer}px wide; ` +
          `[files-rail-toggle] ${(await pressable(page, 'files-rail-toggle')) ? 'IS' : 'is NOT'} still pressable`,
      );
      expect(open.viewer, 'the open tree takes width from the viewer').toBe(PHONE.width);
      expect(open.left, 'the tree did not come out').toBe(0);
      await shoot(page, '06-files-tree-open');
    }

    // A file picked from the overlay shuts it and is read full width.
    await tree(page, 'open');
    await named('src').click();
    await page.waitForTimeout(400);
    await named('src/lib').click();
    await page.waitForTimeout(400);
    await named('src/lib/deep.ts').click();
    await expect
      .poll(() => page.getByTestId('files-viewer').getAttribute('data-file'), { timeout: WAIT })
      .toBe(`${fixture}/src/lib/deep.ts`);
    await page.waitForTimeout(1500);
    const afterPick = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="files-rail"]') as HTMLElement | null;
      const el = document.querySelector('[data-testid="file-viewer"] .cm-content') as HTMLElement | null;
      const scroller = el?.closest('.cm-scroller') as HTMLElement | null;
      const header = document.querySelector('[data-testid="file-viewer-header"]') as HTMLElement | null;
      return {
        railLeft: rail ? Math.round(rail.getBoundingClientRect().left) : -1,
        code: scroller ? { shown: scroller.clientWidth, scroll: scroller.scrollWidth } : null,
        header: header ? { shown: header.clientWidth, scroll: header.scrollWidth } : null,
      };
    });
    note(
      `Files tab, a text file at 390px: the tree ${afterPick.railLeft < 0 ? 'is gone' : `sits at x=${afterPick.railLeft}`}; ` +
        `the code pane shows ${afterPick.code?.shown ?? -1}px of a ${afterPick.code?.scroll ?? -1}px line; ` +
        `[file-viewer-header] holds ${afterPick.header?.scroll ?? -1}px in ${afterPick.header?.shown ?? -1}px`,
    );
    expect(afterPick.railLeft, 'the tree stayed over the file it just opened').toBeLessThan(0);
    expect(afterPick.code!.shown, 'the code pane is not the width of the screen').toBe(PHONE.width);
    expect(
      afterPick.header!.scroll,
      "[file-viewer-header]'s buttons are off the right of the pane",
    ).toBeLessThanOrEqual(afterPick.header!.shown + 1);
    await shoot(page, '07-files-text');

    // The Markdown preview, which is where a 102px viewer showed one letter per line.
    await tree(page, 'open');
    await named('README.md').click();
    await expect
      .poll(() => page.getByTestId('files-viewer').getAttribute('data-file'), { timeout: WAIT })
      .toBe(`${fixture}/README.md`);
    await page.waitForTimeout(1500);
    const heading = await page.evaluate(() => {
      const h = document.querySelector('[data-testid="file-preview"] h1') as HTMLElement | null;
      if (!h) return null;
      const box = h.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    });
    note(`Files tab, README.md previewed at 390px: its heading is ${heading?.width ?? -1}px wide and ${heading?.height ?? -1}px tall`);
    // One letter to a line made a two-word heading 432px tall.
    expect(heading!.height, 'the Markdown heading is still being broken up').toBeLessThan(120);
    await shoot(page, '08-files-markdown');

    // And a picture, which had a 102px stage to fit 160px into.
    await tree(page, 'open');
    await named('assets').click();
    await page.waitForTimeout(500);
    await named('assets/shot.png').click();
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'image', { timeout: WAIT });
    await page.waitForTimeout(1500);
    const stage = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="file-preview-image-stage"]') as HTMLElement | null;
      const img = document.querySelector('[data-testid="file-preview-image-stage"] img') as HTMLElement | null;
      return {
        stage: el ? Math.round(el.getBoundingClientRect().width) : -1,
        picture: img ? Math.round(img.getBoundingClientRect().width) : -1,
      };
    });
    note(`Files tab, a picture at 390px: the stage is ${stage.stage}px and the picture ${stage.picture}px`);
    expect(stage.stage, 'the picture has nowhere to be shown').toBeGreaterThanOrEqual(stage.picture);
    await shoot(page, '09-files-image');

    // And the same tab on a wide screen, which must be exactly what it was: a
    // column of the row, its width the one the divider drags, no toggle and no
    // scrim in sight.
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.waitForTimeout(1500);
    const wide = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="files-rail"]') as HTMLElement | null;
      const viewer = document.querySelector('[data-testid="files-viewer"]') as HTMLElement | null;
      const divider = document.querySelector('[data-testid="left-panel-resizer"]') as HTMLElement | null;
      const toggle = document.querySelector('[data-testid="files-rail-toggle"]') as HTMLElement | null;
      const scrim = document.querySelector('[data-testid="files-rail-scrim"]') as HTMLElement | null;
      const drawn = (el: HTMLElement | null) => (el ? getComputedStyle(el).display !== 'none' : false);
      return {
        rail: rail ? Math.round(rail.getBoundingClientRect().width) : -1,
        left: rail ? Math.round(rail.getBoundingClientRect().left) : -1,
        position: rail ? getComputedStyle(rail).position : 'none',
        viewer: viewer ? Math.round(viewer.getBoundingClientRect().width) : -1,
        divider: drawn(divider),
        toggle: drawn(toggle),
        scrim: drawn(scrim),
      };
    });
    note(
      `Files tab at 1024px: the rail is ${wide.rail}px ${wide.position} at x=${wide.left} beside a ${wide.viewer}px viewer; ` +
        `the divider is ${wide.divider ? 'drawn' : 'hidden'}, the toggle ${wide.toggle ? 'drawn' : 'hidden'}, the scrim ${
          wide.scrim ? 'drawn' : 'hidden'
        }`,
    );
    // A wide screen is exactly what it was.
    expect(wide.position, 'the rail is no longer a column on a wide screen').toBe('relative');
    expect(wide.rail + wide.viewer, 'the rail and the viewer no longer fill the row').toBeGreaterThanOrEqual(1020);
    expect(wide.divider, 'the divider cannot be dragged on a wide screen').toBe(true);
    expect(wide.toggle, 'a phone-only toggle is drawn on a wide screen').toBe(false);
    expect(wide.scrim, 'a phone-only scrim is drawn on a wide screen').toBe(false);
    await shoot(page, '10-files-wide');
  } finally {
    const report = ['', `======== THE PHONE RAILS (${STAGE}) ========`, '', ...measured.map((one) => `   * ${one}`), ''].join('\n');
    console.log(report);
    writeFileSync(`${SHOTS}/measurements.txt`, report);
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
