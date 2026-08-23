import { mkdirSync } from 'node:fs';

import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Does the app draw whole on a phone.
 *
 * The suite that was here before this one drove a 1440x900 window and nothing
 * else, so every screen was only ever judged at a width no phone has. This
 * walks the same screens at the three widths people actually hold — a modern
 * phone, a small one, and a tablet held upright — opens every panel and popup
 * on the way, and fails on four things a reader would call broken: the page
 * scrolls sideways, something is drawn past the edge of the screen, words are
 * cut off with no sign that they were, or a control is too small to hit with a
 * thumb.
 *
 * It also saves a picture of each screen under tests/results/responsive/,
 * because the manager signs this work off by looking at the pictures rather
 * than by reading a pass line (bw-81wt).
 *
 * Run it against the preview serving the copy of the code you are changing:
 *
 *   BEADS_E2E_URL=http://127.0.0.1:3017 npx playwright test tests/responsive.spec.ts
 */

/** A current phone, upright. The width the manager judges by. */
const PHONE = { width: 390, height: 844 };
/** A small phone. Anything that only just fits at 390 fails here. */
const NARROW = { width: 360, height: 740 };
/** A tablet upright — wide enough for two columns, too narrow for a desktop. */
const TABLET = { width: 768, height: 1024 };

/** Where the pictures the manager looks at are written. */
const SHOTS = 'tests/results/responsive';

/**
 * The smallest a control may be on a screen you touch.
 *
 * The accessibility rule floors this at 24 pixels and the phone makers ask for
 * 44; a thumb is about 9 millimetres of glass either way. 40 is what this
 * project holds itself to, and only where the pointer is coarse — a mouse
 * hits a 28-pixel icon perfectly well and the desktop bars are built from them.
 */
const TAP = 40;

/** A dev preview compiles a route the first time it is asked for. */
const WAY_IN_MS = 60_000;

mkdirSync(SHOTS, { recursive: true });

interface Offender {
  what: string;
  left: number;
  right: number;
  width: number;
  height: number;
}

/**
 * Everything drawn outside the screen.
 *
 * An element sitting past the right edge is only a fault if nothing can bring
 * it into view: the board's strip of columns is deliberately wider than the
 * window and is scrolled sideways, and the columns hanging off it are not
 * lost. So anything inside an ancestor that scrolls sideways is left alone,
 * and everything else past the edge is reported.
 */
async function offscreen(page: Page): Promise<Offender[]> {
  return page.evaluate(() => {
    const out: Array<{ what: string; left: number; right: number; width: number; height: number }> = [];
    const name = (el: Element) => {
      const id = el.getAttribute('data-testid');
      const label = el.getAttribute('aria-label');
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).slice(0, 3).join('.');
      return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''}${label ? `("${label}")` : ''}${cls ? `.${cls}` : ''}`;
    };
    /** Inside something that scrolls sideways, so it can be brought into view. */
    const reachable = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const style = getComputedStyle(p);
        const scrolls = style.overflowX === 'auto' || style.overflowX === 'scroll';
        if (scrolls && p.scrollWidth > p.clientWidth + 1) return true;
      }
      return false;
    };
    /**
     * How much of an element is actually painted, after every ancestor that
     * clips has had its say.
     *
     * Two things this settles, and they are the same thing. A drawer that is
     * shut is parked off the side of a pane that clips it: none of it is on the
     * screen and none of it makes the screen wider — that is how a drawer is
     * shut, not a thing drawn past the edge. And a long command line inside a
     * row that truncates has a BOX running off the side while what is drawn
     * ends in an ellipsis well inside the screen; judging the box failed the
     * whole run on whichever chat happened to be first in the list
     * (bw-81wt.20).
     *
     * So the box is cut down to what survives its clipping ancestors, and that
     * is what gets judged. An empty result means nothing of it is drawn at all.
     */
    const painted = (el: Element): { left: number; right: number } | null => {
      const r = el.getBoundingClientRect();
      let left = r.left;
      let right = r.right;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
        const box = p.getBoundingClientRect();
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
        if (right <= left) return null;
      }
      return { left, right };
    };
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const seen = painted(el);
      if (!seen) continue;
      const past = seen.right > window.innerWidth + 1 || seen.left < -1;
      if (!past) continue;
      if (reachable(el)) continue;
      out.push({ what: name(el), left: Math.round(seen.left), right: Math.round(seen.right), width: Math.round(r.width), height: Math.round(r.height) });
    }
    return out;
  });
}

/**
 * Words cut off with nothing to say they were cut.
 *
 * A name trimmed with an ellipsis is a decision somebody made and the reader
 * can see it happened. A name that simply stops at the edge of its box reads
 * as the whole name, and is the fault this looks for.
 */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (!el.textContent?.trim()) continue;
      if (el.children.length > 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (style.overflow !== 'hidden' && style.overflowX !== 'hidden') continue;
      if (style.textOverflow === 'ellipsis') continue;
      // Words put there only for a screen reader are hidden in a 1-pixel box
      // on purpose; they are not drawn at all, so they cannot be cut off.
      if (el.clientWidth <= 4 || el.clientHeight <= 4) continue;
      if (style.clipPath !== 'none') continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      out.push(`${el.tagName.toLowerCase()}: "${el.textContent.trim().slice(0, 40)}" ${el.scrollWidth}px in ${el.clientWidth}px`);
    }
    return out;
  });
}

/** Every control a thumb is meant to hit, and how big it actually is. */
async function tooSmall(page: Page, floor: number): Promise<string[]> {
  return page.evaluate((floor) => {
    const out: string[] = [];
    const controls = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), select, textarea, [role="switch"], [role="checkbox"]';
    for (const el of Array.from(document.body.querySelectorAll(controls))) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      // A control that sits inside a sentence is part of the sentence: a link
      // in prose, a word you can copy. Growing it would pull the paragraph
      // apart, and the rule that gives everything else a floor deliberately
      // does not reach an inline box either.
      if (style.display === 'inline') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // A control inside another control is one target, not two.
      if (el.parentElement?.closest(controls)) continue;
      if (r.width >= floor && r.height >= floor) continue;
      const id = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24) ?? el.tagName;
      out.push(`${id}: ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }, floor);
}

/** The page itself never scrolls sideways, whatever a pane inside it does. */
async function pageScrollsSideways(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - window.innerWidth;
  });
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/**
 * Everything one screen is judged on, in one call.
 *
 * `where` names the picture and every failure, so a red run says which screen
 * at which width without anybody opening the test.
 */
async function judge(page: Page, where: string, opts: { tap?: boolean } = {}) {
  await shoot(page, where);
  const over = await pageScrollsSideways(page);
  expect(over, `${where}: the page scrolls ${over}px sideways`).toBeLessThanOrEqual(1);

  const past = await offscreen(page);
  expect(past.map((o) => `${o.what} at ${o.left}..${o.right}`), `${where}: drawn past the edge of the screen`).toEqual([]);

  const cut = await clipped(page);
  expect(cut, `${where}: words cut off with no ellipsis`).toEqual([]);

  if (opts.tap !== false) {
    const small = await tooSmall(page, TAP);
    expect(small, `${where}: controls under ${TAP}px on a touch screen`).toEqual([]);
  }
}

/** The project the run drives. The first real one the board knows about. */
async function projectId(page: Page): Promise<string> {
  // A dev preview serves the screens and nothing else — the board it reads
  // from answers on its own port, which is what BEADS_E2E_BACKEND names.
  const board = process.env.BEADS_E2E_BACKEND ?? '';
  const res = await page.request.get(`${board}/api/projects`);
  expect(res.ok(), 'the board did not answer /api/projects').toBeTruthy();
  const projects = (await res.json()) as Array<{ id: string; isTest?: boolean }>;
  const real = projects.find((p) => !p.isTest) ?? projects[0];
  expect(real, 'no project to drive the screens with').toBeTruthy();
  return real.id;
}

async function openProject(page: Page, tab: 'board' | 'chat' | 'reports') {
  const id = await projectId(page);
  await page.goto(`/project?id=${id}&tab=${tab}`);
  await page.waitForSelector('[data-testid="shell"]', { timeout: WAY_IN_MS });
  await page.waitForTimeout(1200);
  return id;
}

/** A phone is a touch screen: `hasTouch` is what makes the pointer coarse. */
const onAPhone = { viewport: PHONE, hasTouch: true, isMobile: true };
const onASmallPhone = { viewport: NARROW, hasTouch: true, isMobile: true };
const onATablet = { viewport: TABLET, hasTouch: true, isMobile: true };

// ─── Which copy of the app answered ───

/**
 * The one question asked before any screen is judged.
 *
 * The address defaults to the installed program on port 3008, whose screens
 * were built into the binary and are as old as the last release. Pointed
 * there, this sweep judges last month's app: most cases go red on controls
 * that were fixed weeks ago, and every message blames a screen rather than the
 * stale copy that served it — an afternoon went that way once (bw-81wt.24).
 *
 * So the run asks the app itself: on a touch screen, is a plain button floored
 * at forty pixels, as this project's own stylesheet has floored every control
 * since the phone work began? An app that says no is older than this suite,
 * and the run stops with one sentence naming the address it reached instead of
 * twenty verdicts about screens nobody is looking at.
 */
const GUARD = 'the app answering is the one this sweep was written for';

/** How to reach a copy of the app that is actually the code being changed. */
const INSTEAD =
  'Point the sweep at a preview of the code you are changing — ' +
  'BEADS_E2E_URL=http://127.0.0.1:3017 npx playwright test tests/responsive.spec.ts — ' +
  'or rebuild the program so it serves the current screens.';

/** A sentence when the wrong app answered, null when the right one did. */
let wrongApp: string | null = null;

async function askTheApp(browser: Browser, at: string): Promise<string | null> {
  let context = null;
  try {
    context = await browser.newContext({ baseURL: at, ...onAPhone });
    const page = await context.newPage();
    await page.goto('/', { timeout: WAY_IN_MS });
    const floor = await page.evaluate(() => {
      const probe = document.createElement('button');
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const got = { tall: parseFloat(style.minHeight) || 0, wide: parseFloat(style.minWidth) || 0 };
      probe.remove();
      return got;
    });
    if (floor.tall >= TAP && floor.wide >= TAP) return null;
    // An app with no such rule at all reports nothing rather than a number,
    // and "0 by 0 pixels" would read as a measurement it never made.
    const measured =
      floor.tall === 0 && floor.wide === 0
        ? 'sets no thumb-sized floor on a plain button at all'
        : `floors a plain button at ${floor.wide} by ${floor.tall} pixels`;
    return (
      `The app answering at ${at} is older than this work: on a touch screen it ${measured}, ` +
      `and this project floors every control at ${TAP}. The screens it is serving were built ` +
      `before the phone work, so judging them says nothing about the code in this worktree. ` +
      `${INSTEAD}`
    );
  } catch (e) {
    return `Nothing this sweep can judge answered at ${at}: ${e instanceof Error ? e.message : String(e)}. ${INSTEAD}`;
  } finally {
    await context?.close();
  }
}

// Once per worker, before anything is judged.
test.beforeAll(async ({ browser }) => {
  wrongApp = await askTheApp(browser, test.info().project.use.baseURL ?? 'http://localhost:3008');
});

test.beforeEach(() => {
  // Every case but the guard steps aside when the wrong app answered, so the
  // run reports one sentence about the app rather than twenty verdicts about
  // screens it never reached.
  if (wrongApp && test.info().title !== GUARD) test.skip(true, wrongApp);
});

test(GUARD, async () => {
  expect(wrongApp, wrongApp ?? 'the app answering is the one this sweep was written for').toBeNull();
});

// ─── The project list ───

test.describe('project list', () => {
  // A phone is a touch screen, so the thumb-sized floor is in force here.
  test.use({ hasTouch: true, isMobile: true });

  for (const [label, opts] of [['390', onAPhone], ['360', onASmallPhone], ['768', onATablet]] as const) {
    test(`project list fits at ${label}`, async ({ page }) => {
      await page.setViewportSize(opts.viewport);
      await page.goto('/');
      await page.waitForSelector('[data-testid="shell"], main', { timeout: WAY_IN_MS });
      await page.waitForTimeout(800);
      await judge(page, `list-${label}`);
    });
  }

  test('project list shows two projects without scrolling', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    await page.waitForTimeout(1500);
    // The heading used to eat the top 60% of the screen, so one and a half
    // cards were all a phone ever showed.
    const whole = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[role="link"][aria-label^="View "]'));
      return cards.filter((c) => c.getBoundingClientRect().bottom <= window.innerHeight).length;
    });
    expect(whole, 'whole project cards visible on a phone without scrolling').toBeGreaterThanOrEqual(2);
  });
});

// ─── The board ───

test.describe('board', () => {
  // A phone is a touch screen, so the thumb-sized floor is in force here.
  test.use({ hasTouch: true, isMobile: true });

  test('board columns land squarely at 390', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'board');
    const strip = page.locator('[data-testid="board-scroll"]');
    await expect(strip).toBeVisible();

    // One column per screen, and a swipe stops on the next one rather than
    // between two.
    const shape = await strip.evaluate((el) => {
      const first = el.firstElementChild?.firstElementChild as HTMLElement | undefined;
      return {
        snap: getComputedStyle(el).scrollSnapType,
        childSnap: first ? getComputedStyle(first).scrollSnapAlign : 'none',
        column: first ? Math.round(first.getBoundingClientRect().width) : 0,
        window: window.innerWidth,
      };
    });
    expect(shape.snap, 'the board strip does not snap sideways').toContain('x');
    expect(shape.childSnap, 'a board column does not say where a swipe should land').not.toBe('none');
    expect(shape.column, `one column should fill the screen, it is ${shape.column} of ${shape.window}`).toBeGreaterThan(shape.window * 0.8);

    await expect(page.locator('[data-testid="column-tabs"]'), 'no row of column names to say which column you are on').toBeVisible();
    await shoot(page, 'board-390-col1');
    await judge(page, 'board-390');
  });

  test('board tools are all reachable at 390', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'board');
    // The tool row held 155 pixels of a 289-pixel strip and did not scroll, so
    // New, the filters, the agents panel and the memory panel were invisible
    // and unclickable on a phone.
    for (const label of ['New', 'Filter options', 'Agents', 'Memory']) {
      const control = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
      await expect(control, `${label} is not on the board's tool row`).toBeAttached();
      await control.scrollIntoViewIfNeeded();
      await expect(control, `${label} cannot be clicked at 390 wide`).toBeVisible();
      const box = await control.boundingBox();
      expect(box, `${label} has no box`).toBeTruthy();
      expect(box!.x + box!.width, `${label} is drawn off the right of a 390 screen`).toBeLessThanOrEqual(PHONE.width + 1);
      expect(Math.min(box!.width, box!.height), `${label} is smaller than a thumb`).toBeGreaterThanOrEqual(TAP);
    }
    await shoot(page, 'board-tools-390');
  });

  test('card panel fits a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'board');
    const card = page.locator('[data-bead-id]').first();
    await card.scrollIntoViewIfNeeded();
    await card.click();
    const panel = page.locator('[data-testid="bead-detail"]');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(600);

    const width = await panel.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    expect(width, 'the card panel does not fill a phone screen').toBeGreaterThan(PHONE.width * 0.95);

    // Two ways out — a Back arrow and a cross — is one too many.
    const closers = await page.locator('[data-testid="bead-detail"] [aria-label*="lose" i], [data-testid="bead-detail"] [aria-label*="ack" i]').count();
    expect(closers, 'the card panel has more than one way to close it').toBeLessThanOrEqual(1);

    await judge(page, 'card-390');
  });
});

// ─── The chat ───

test.describe('chat', () => {
  // A phone is a touch screen, so the thumb-sized floor is in force here.
  test.use({ hasTouch: true, isMobile: true });

  test('chat tools are all reachable at 390', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'chat');
    // New Chat sat at x=423 on a 390 screen — off the side and unclickable —
    // because the tool row held 155 pixels of a 289-pixel strip and did not
    // scroll. Search, the chats list and New Chat now live in the chat
    // sidebar; what is left on the bar is the two panel toggles.
    const sidebar = page.getByRole('button', { name: /chats|sessions/i }).first();
    await expect(sidebar, 'nothing on the bar opens the chat list').toBeAttached();
    await sidebar.click();
    await page.waitForTimeout(400);
    for (const name of [/new chat/i, /search/i]) {
      const control = page.getByRole('button', { name }).first();
      await expect(control, `${name} is not in the chat sidebar`).toBeVisible();
      const box = await control.boundingBox();
      expect(box!.x + box!.width, `${name} is drawn off the right of a 390 screen`).toBeLessThanOrEqual(PHONE.width + 1);
      expect(box!.x, `${name} is drawn off the left of a 390 screen`).toBeGreaterThanOrEqual(-1);
    }
    await shoot(page, 'chat-tools-390');
  });

  test('each panel button sits on the edge it opens', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'chat');

    // A chat has to be open for the right-hand panel to have a door at all.
    const first = page.locator('[data-testid="chat-list"] [data-testid="row-name"]').first();
    if (!(await page.locator('[data-testid="chat-right-rail-toggle"]').count()) && (await first.count())) {
      await page.locator('[data-testid="chat-rail-toggle"]').first().click();
      await page.waitForTimeout(400);
      await first.click();
      await page.waitForTimeout(2000);
    }

    // The bar's own edges, its padding taken off: a button cannot sit closer to
    // the edge than the bar lets anything sit.
    const inside = await page.locator('[data-testid="tab-bar"]').evaluate((el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight) };
    });

    const chats = await page.locator('[data-testid="chat-rail-toggle"]').first().boundingBox();
    expect(chats, 'nothing on the bar opens the chat list').not.toBeNull();
    expect(
      Math.abs(chats!.x - inside.left),
      'the chat list button is not on the left edge it opens from',
    ).toBeLessThanOrEqual(8);

    const details = page.locator('[data-testid="chat-right-rail-toggle"]').first();
    if (!(await details.count())) return;
    const box = await details.boundingBox();
    expect(
      Math.abs(inside.right - (box!.x + box!.width)),
      'the right-hand panel button is adrift in the middle of the bar instead of on the edge it opens from',
    ).toBeLessThanOrEqual(8);
  });

  test('both phone panels are full-height sheets with a way out inside them', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'chat');

    /**
     * As tall as the SCREEN, not as tall as the box under the bars: the
     * manager asked for proper side sheets, and a sheet that starts below the
     * bars is a box inside the page (bw-81wt.30).
     */
    const fillsTheHeight = async (testid: string) => {
      const short = await page.locator(`[data-testid="${testid}"]`).evaluate((el) => {
        const box = el.getBoundingClientRect();
        return { top: Math.round(box.top), short: Math.round(window.innerHeight - box.height) };
      });
      expect(short.short, `the ${testid} sheet is short of the screen by ${short.short}px`).toBeLessThanOrEqual(1);
      expect(short.top, `the ${testid} sheet starts ${short.top}px down the screen, under the bars`).toBeLessThanOrEqual(1);
    };

    /** The dimmed screen behind a sheet covers all of it, bars included. */
    const dimsTheScreen = async (testid: string) => {
      const gap = await page.locator(`[data-testid="${testid}"]`).evaluate((el) => {
        const box = el.getBoundingClientRect();
        return Math.round(window.innerHeight - box.height) + Math.round(box.top);
      });
      expect(gap, `the ${testid} leaves ${gap}px of the screen undimmed`).toBeLessThanOrEqual(1);
    };

    const shut = async (testid: string) =>
      page.locator(`[data-testid="${testid}"]`).getAttribute('data-open');

    // The chat list, on the left.
    await page.locator('[data-testid="chat-rail-toggle"]').first().click();
    await page.waitForTimeout(400);
    await fillsTheHeight('chat-rail');
    await dimsTheScreen('chat-rail-scrim');
    const listCross = page.locator('[data-testid="chat-rail-close"]').first();
    await expect(listCross, 'the chat list drawer has no way out inside it').toBeVisible();
    await listCross.click();
    await page.waitForTimeout(400);
    expect(await shut('chat-rail'), 'the cross did not shut the chat list').toBe('false');

    // And again, shut by tapping the dimmed screen beside it.
    await page.locator('[data-testid="chat-rail-toggle"]').first().click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid="chat-rail-scrim"]').click({ position: { x: 370, y: 400 } });
    await page.waitForTimeout(400);
    expect(await shut('chat-rail'), 'tapping beside the chat list did not shut it').toBe('false');

    // The chat's own column, on the right. It exists only with a chat open.
    const first = page.locator('[data-testid="chat-list"] [data-testid="row-name"]').first();
    if (!(await page.locator('[data-testid="chat-right-rail-toggle"]').count()) && (await first.count())) {
      await page.locator('[data-testid="chat-rail-toggle"]').first().click();
      await page.waitForTimeout(400);
      await first.click();
      await page.waitForTimeout(2000);
    }
    const door = page.locator('[data-testid="chat-right-rail-toggle"]').first();
    if (!(await door.count())) return;
    if ((await shut('chat-right-rail')) === 'false') {
      await door.click();
      await page.waitForTimeout(400);
    }
    await fillsTheHeight('chat-right-rail');
    await dimsTheScreen('chat-right-rail-scrim');
    await judge(page, 'chat-rail-open-390');
    const railCross = page.locator('[data-testid="chat-right-rail-close"]').first();
    await expect(railCross, "the chat's own column has no way out inside it").toBeVisible();
    await railCross.click();
    await page.waitForTimeout(400);
    expect(await shut('chat-right-rail'), "the cross did not shut the chat's own column").toBe('false');

    await door.click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid="chat-right-rail-scrim"]').click({ position: { x: 20, y: 400 } });
    await page.waitForTimeout(400);
    expect(await shut('chat-right-rail'), "tapping beside the chat's own column did not shut it").toBe('false');
  });

  test('a button\u2019s label is drawn whole, not clipped by the pane it sits in', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'chat');

    // A panel scrolls its own contents, which means it clips them — right for
    // the rows inside it, fatal for a label that has to be drawn outside it.
    // The chat list's own search is the control the manager caught it on.
    await page.locator('[data-testid="chat-rail-toggle"]').first().click();
    await page.waitForTimeout(400);
    await page.locator('button[aria-label="Search chats"]').first().hover();
    // The drawn label, not the copy a screen reader is handed: that one is a
    // one-pixel span and would pass any measurement.
    const tip = page.locator('[data-radix-popper-content-wrapper] > *').first();
    await expect(tip, 'hovering a control inside the chat list showed no label at all').toBeVisible({ timeout: 5_000 });

    const where = await tip.evaluate((el) => {
      const box = el.getBoundingClientRect();
      /** The nearest thing above it that cuts off whatever overflows. */
      let clipper: string | null = null;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (/hidden|auto|scroll|clip/.test(style.overflowX + style.overflowY)) {
          const r = p.getBoundingClientRect();
          if (box.left < r.left - 1 || box.right > r.right + 1 || box.top < r.top - 1 || box.bottom > r.bottom + 1) {
            clipper = p.getAttribute('data-testid') ?? p.tagName.toLowerCase();
            break;
          }
        }
      }
      return { clipper, left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
    });

    // Kept, because this is one the manager looks at rather than reads.
    await shoot(page, 'label-390');
    expect(where.clipper, `the label is cut off by ${where.clipper}, which clips what overflows it`).toBeNull();
    expect(where.left, 'the label hangs off the left of the screen').toBeGreaterThanOrEqual(0);
    expect(where.right, 'the label hangs off the right of the screen').toBeLessThanOrEqual(PHONE.width);
    expect(where.width, 'the label is drawn as a sliver').toBeGreaterThan(20);
  });

  test('a button with a picture and words keeps them apart', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'chat');
    await page.locator('[data-testid="chat-rail-toggle"]').first().click();
    await page.waitForTimeout(400);

    const gap = await page.locator('[data-testid="new-chat-tool"]').evaluate((el) => {
      const icon = el.querySelector('svg');
      const words = [...el.childNodes].find((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
      if (!icon || !words) return null;
      const range = document.createRange();
      range.selectNodeContents(words);
      return Math.round(range.getBoundingClientRect().left - icon.getBoundingClientRect().right);
    });

    expect(gap, 'the New Chat button has no picture and words to keep apart').not.toBeNull();
    expect(gap!, `the picture and the words are ${gap}px apart, which reads as one jammed-together lump`).toBeGreaterThanOrEqual(4);
  });

  test('chat screen fits a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'chat');
    await judge(page, 'chat-390');

    // Shut, the right rail must not leave a strip of dead width beside the
    // transcript; open, it is a sheet over the screen, not a column beside it.
    const rail = page.locator('[data-testid="chat-right-rail"]');
    if (await rail.count()) {
      const shut = await rail.evaluate((el) => Math.round(el.getBoundingClientRect().width));
      expect(shut, 'the shut right rail still eats width on a phone').toBeLessThanOrEqual(1);
    }
    const toggle = page.getByRole('button', { name: /details|rail|panel/i }).first();
    if (await toggle.count()) {
      await toggle.click();
      await page.waitForTimeout(400);
      await judge(page, 'chat-rail-390');
    }
  });

  test('the what-it-cost button is gone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'chat');
    await expect(page.locator('[data-testid="open-spend"]'), 'the what-it-cost button is still on the bar').toHaveCount(0);
    await expect(page.getByText('What it cost', { exact: false }), 'the app still says "What it cost"').toHaveCount(0);
  });
});

// ─── Everything that opens over a screen ───

test.describe('overlays and dialogs', () => {
  // A phone is a touch screen, so the thumb-sized floor is in force here.
  test.use({ hasTouch: true, isMobile: true });

  test('overlays fill a phone screen', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'chat');

    /** How wide the box inside the dimmed page is — not the dimmed page. */
    const panelWidth = () =>
      page.evaluate(() => {
        const back = Array.from(document.querySelectorAll('div')).find(
          (d) =>
            getComputedStyle(d).position === 'fixed' &&
            Math.round(d.getBoundingClientRect().width) === window.innerWidth &&
            d.firstElementChild,
        );
        const box = back?.firstElementChild?.getBoundingClientRect();
        return box ? Math.round(box.width) : null;
      });

    /**
     * A panel on a phone takes the screen; a 2rem inset leaves 326 of 390.
     *
     * And Escape puts it away again: the panel IS the screen here, so a reader
     * who does not spot the small cross in the corner has no way back at all
     * (bw-81wt.18).
     */
    const fillsTheScreen = async (name: string, testid: string) => {
      const wide = await panelWidth();
      expect(wide, `no ${name} panel opened`).not.toBeNull();
      expect(wide!, `the ${name} panel is inset on a phone`).toBeGreaterThanOrEqual(PHONE.width - 1);
      await judge(page, `overlay-${name}-390`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      expect(
        await page.locator(`[data-testid="${testid}"]`).count(),
        `the ${name} panel is still there after Escape`,
      ).toBe(0);
    };

    // Search lives in the chat list now, and on a phone the list is a drawer:
    // everything in it is parked off the side until its handle is tapped.
    const drawer = page.locator('[data-testid="chat-rail-toggle"]').first();
    await drawer.click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid="open-search"]').first().click();
    await page.waitForTimeout(600);
    await fillsTheScreen('search', 'search-panel');

    // The usage and token panels open from the chips on the working strip, so
    // a chat has to be open before either of them exists. Picking one from the
    // list also shuts the drawer, which is why search goes first.
    const firstChat = page.locator('[data-testid="chat-list"] [data-testid="row-name"]').first();
    if (!(await firstChat.count())) return;
    await firstChat.click();
    await page.waitForTimeout(2500);

    // The chip names are the ones the app really draws. This used to ask for
    // `plan-chip-session`, which nothing anywhere renders, so the usage panel
    // was skipped in silence on every run and had never been measured at all
    // (bw-81wt.19).
    for (const [name, chipId, panelId] of [
      ['usage', 'plan-chip', 'usage-view'],
      ['token', 'context-chip-open', 'token-view'],
    ] as const) {
      const chip = page.locator(`[data-testid="${chipId}"]`).first();
      // A machine with no plan reported draws no plan chip, and that is not a
      // fault in how wide its panel would have been.
      if (!(await chip.count())) continue;
      await chip.scrollIntoViewIfNeeded();
      await chip.click();
      await page.waitForTimeout(700);
      await fillsTheScreen(name, panelId);
    }
  });

  test('dialogs fit a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    await page.waitForTimeout(1200);

    const add = page.getByRole('button', { name: /add project/i }).first();
    if (await add.count()) {
      await add.click();
      await page.waitForTimeout(600);
      await judge(page, 'dialog-add-project-390');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    await openProject(page, 'board');
    const create = page.getByRole('button', { name: /^new$/i }).first();
    if (await create.count()) {
      await create.scrollIntoViewIfNeeded();
      await create.click();
      await page.waitForTimeout(600);
      await judge(page, 'dialog-new-bead-390');
      await page.keyboard.press('Escape');
    }
  });

  /**
   * The three things a card opens, which nothing else here reaches.
   *
   * The folder browser lives two clicks in — Add Project, then Browse — and the
   * tag picker, the colour picker inside it and the open-with menu all hang off
   * a project card. Every one of them was hand-fitted for a phone, and until
   * this case existed the sweep judged none of them (bw-81wt.22).
   */
  test('the popups behind a card and a dialog fit a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    await page.waitForTimeout(1200);

    // Every open below is asserted rather than skipped when it is not found:
    // an `if` here is how the sweep spent a month judging a panel it never
    // opened (bw-81wt.19).
    const add = page.getByRole('button', { name: /add project/i }).first();
    await expect(add, 'no Add Project button on the list').toHaveCount(1);
    await add.click();
    await page.waitForTimeout(600);
    const browse = page.getByRole('button', { name: /browse/i }).first();
    await expect(browse, 'no Browse button in the Add Project dialog').toHaveCount(1);
    await browse.click();
    await page.waitForTimeout(900);
    await judge(page, 'dialog-folder-browser-390');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    const tags = page.getByRole('button', { name: /^add tag$/i }).first();
    await expect(tags, 'no Add tag button on a project card').toHaveCount(1);
    await tags.click();
    await page.waitForTimeout(600);
    await judge(page, 'popover-tags-390');

    // The colour picker opens INSIDE the tag picker, under "Create new tag" —
    // the only place in the app where a popover sits on top of another one.
    const making = page.getByRole('button', { name: /create new tag/i }).first();
    await expect(making, 'no way to create a tag in the tag picker').toHaveCount(1);
    await making.click();
    await page.waitForTimeout(400);
    const colour = page.getByRole('button', { name: /pick a color/i }).first();
    await expect(colour, 'no colour picker in the new-tag row').toHaveCount(1);
    await colour.click();
    await page.waitForTimeout(600);
    await judge(page, 'popover-colour-390');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    const openWith = page.getByRole('button', { name: /open in external application/i }).first();
    await expect(openWith, 'no open-with button on a project card').toHaveCount(1);
    await openWith.click();
    await page.waitForTimeout(600);
    await judge(page, 'menu-open-with-390');
    await page.keyboard.press('Escape');
  });

  for (const [label, size] of [['390', PHONE], ['360', NARROW]] as const) {
    test(`the update notice fits a phone at ${label}`, async ({ page }) => {
      await page.setViewportSize(size);
      // The notice only draws when there is a newer release, and usually there
      // is not, so the run answers the version question itself rather than
      // waiting for one.
      await page.route('**/api/version/check', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            current: '0.15.0',
            latest: '0.16.0',
            update_available: true,
            download_url: 'https://example.invalid/release',
            release_notes: null,
            asset_url: 'https://example.invalid/asset',
          }),
        }),
      );
      await openProject(page, 'chat');

      const notice = page.locator('[data-testid="update-banner"]');
      await expect(notice, 'the update notice never appeared').toBeVisible({ timeout: WAY_IN_MS });
      const box = await notice.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right) };
      });

      expect(box.left, `the update notice starts ${box.left}px from the left, off the screen`).toBeGreaterThanOrEqual(0);
      expect(box.right, `the update notice ends ${box.right}px across a ${size.width}px screen`).toBeLessThanOrEqual(size.width);
      await judge(page, `update-notice-${label}`);

      // And with a sheet open it is background, not a torn-off strip beside
      // it: the notice floated at the same height as the dimming, so the sheet
      // covered its left two thirds and what stuck out past the sheet read as
      // half a sentence (bw-81wt.33).
      await page.locator('[data-testid="chat-rail-toggle"]').first().click();
      await page.waitForTimeout(600);
      const showing = await notice.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return [0.1, 0.5, 0.9]
          .map((across) => {
            const hit = document.elementFromPoint(
              Math.round(r.left + r.width * across),
              Math.round(r.top + r.height / 2),
            );
            let owner: Element | null = hit;
            while (owner && !owner.getAttribute('data-testid')) owner = owner.parentElement;
            return owner?.getAttribute('data-testid') === 'update-banner' ? Math.round(across * 100) : null;
          })
          .filter((at): at is number => at !== null);
      });
      expect(
        showing,
        `with the chat list open the update notice is still drawn over it, ${showing.length} of 3 points across`,
      ).toEqual([]);
      await shoot(page, `update-notice-${label}-under-sheet`);
    });
  }
});

// ─── Reports and settings ───

test.describe('reports', () => {
  // A phone is a touch screen, so the thumb-sized floor is in force here.
  test.use({ hasTouch: true, isMobile: true });

  test('reports fit a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'reports');
    await judge(page, 'reports-390');

    const first = page.locator('[data-testid="reports-list-item"]').first();
    if (await first.count()) {
      await first.click();
      await page.waitForTimeout(1500);
      await judge(page, 'report-doc-390');
    }
  });
});

test.describe('settings', () => {
  // A phone is a touch screen, so the thumb-sized floor is in force here.
  test.use({ hasTouch: true, isMobile: true });

  test('settings fit a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/settings');
    await page.waitForTimeout(1200);
    await judge(page, 'settings-390');
  });
});

// ─── The thumb ───

test.describe('tap targets', () => {
  // A phone is a touch screen, so the thumb-sized floor is in force here.
  test.use({ hasTouch: true, isMobile: true });

  for (const [where, path] of [
    ['list', '/'],
    ['settings', '/settings'],
  ] as const) {
    test(`tap targets on the ${where}`, async ({ page }) => {
      await page.setViewportSize(PHONE);
      await page.goto(path);
      await page.waitForTimeout(1200);
      const small = await tooSmall(page, TAP);
      expect(small, `${where}: controls under ${TAP}px on a touch screen`).toEqual([]);
    });
  }

  for (const tab of ['board', 'chat'] as const) {
    test(`tap targets on the ${tab}`, async ({ page }) => {
      await page.setViewportSize(PHONE);
      await openProject(page, tab);
      const small = await tooSmall(page, TAP);
      expect(small, `${tab}: controls under ${TAP}px on a touch screen`).toEqual([]);
    });
  }

});

// ─── With a mouse, nothing changed ───

test.describe('a mouse', () => {
  test.use({ hasTouch: false, isMobile: false });

  test('tap targets are unchanged with a mouse', async ({ page }) => {
    // The floor is a touch rule. A desktop bar built from 28-pixel icons is
    // not a fault and must not be grown to satisfy it.
    await page.setViewportSize({ width: 1440, height: 900 });
    await openProject(page, 'board');
    const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
    expect(coarse, 'a desktop window should not report a coarse pointer').toBeFalsy();
    await shoot(page, 'board-1440');
  });

  test('the shut right rail takes no width on a wide screen either', async ({ page }) => {
    // Its handle used to BE the shut rail, so a thin edge down the side was
    // the way back in. The handle is on the bar now, and what the edge holds
    // is nothing at all (bw-81wt.17).
    await page.setViewportSize({ width: 1440, height: 900 });
    await openProject(page, 'chat');
    const rail = page.locator('[data-testid="chat-right-rail"]');
    if (!(await rail.count())) return;
    const shut = await rail.evaluate((el) => ({
      open: el.getAttribute('data-open'),
      wide: Math.round(el.getBoundingClientRect().width),
    }));
    if (shut.open === 'true') return;
    expect(shut.wide, 'the shut right rail is a strip of dead width on a wide screen').toBeLessThanOrEqual(1);
    await shoot(page, 'chat-rail-shut-1440');
  });
});
