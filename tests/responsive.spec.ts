import { mkdirSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

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
     * Put away rather than spilling out.
     *
     * A drawer that is shut is parked off the side of a pane that clips it, so
     * nothing of it is on the screen and nothing of it makes the screen wider.
     * That is how a drawer is shut, not a thing drawn past the edge.
     */
    const parked = (el: Element) => {
      const r = el.getBoundingClientRect();
      for (let p = el.parentElement; p; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
        const box = p.getBoundingClientRect();
        if (r.right <= box.left + 1 || r.left >= box.right - 1) return true;
      }
      return false;
    };
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const past = r.right > window.innerWidth + 1 || r.left < -1;
      if (!past) continue;
      if (reachable(el)) continue;
      if (parked(el)) continue;
      out.push({ what: name(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) });
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
    await judge(page, 'board-390', { tap: false });
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

    await judge(page, 'card-390', { tap: false });
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

  test('chat screen fits a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'chat');
    await judge(page, 'chat-390', { tap: false });

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
      await judge(page, 'chat-rail-390', { tap: false });
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

    /** A panel on a phone takes the screen; a 2rem inset leaves 326 of 390. */
    const fillsTheScreen = async (name: string) => {
      const wide = await panelWidth();
      expect(wide, `no ${name} panel opened`).not.toBeNull();
      expect(wide!, `the ${name} panel is inset on a phone`).toBeGreaterThanOrEqual(PHONE.width - 1);
      await judge(page, `overlay-${name}-390`, { tap: false });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    };

    // Search lives in the chat list now, and on a phone the list is a drawer:
    // everything in it is parked off the side until its handle is tapped.
    const drawer = page.locator('[data-testid="chat-rail-toggle"]').first();
    await drawer.click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid="open-search"]').first().click();
    await page.waitForTimeout(600);
    await fillsTheScreen('search');

    // The usage and token panels open from the chips on the working strip, so
    // a chat has to be open before either of them exists. Picking one from the
    // list also shuts the drawer, which is why search goes first.
    const firstChat = page.locator('[data-testid="chat-list"] [data-testid="row-name"]').first();
    if (!(await firstChat.count())) return;
    await firstChat.click();
    await page.waitForTimeout(2500);

    for (const [name, testid] of [
      ['usage', 'plan-chip-session'],
      ['token', 'context-chip-open'],
    ] as const) {
      const chip = page.locator(`[data-testid="${testid}"]`).first();
      // A machine with no plan reported draws no plan chip, and that is not a
      // fault in how wide its panel would have been.
      if (!(await chip.count())) continue;
      await chip.scrollIntoViewIfNeeded();
      await chip.click();
      await page.waitForTimeout(700);
      await fillsTheScreen(name);
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
      await judge(page, 'dialog-add-project-390', { tap: false });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    await openProject(page, 'board');
    const create = page.getByRole('button', { name: /^new$/i }).first();
    if (await create.count()) {
      await create.scrollIntoViewIfNeeded();
      await create.click();
      await page.waitForTimeout(600);
      await judge(page, 'dialog-new-bead-390', { tap: false });
      await page.keyboard.press('Escape');
    }
  });
});

// ─── Reports and settings ───

test.describe('reports', () => {
  // A phone is a touch screen, so the thumb-sized floor is in force here.
  test.use({ hasTouch: true, isMobile: true });

  test('reports fit a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openProject(page, 'reports');
    await judge(page, 'reports-390', { tap: false });

    const first = page.locator('[data-testid="reports-list-item"]').first();
    if (await first.count()) {
      await first.click();
      await page.waitForTimeout(1500);
      await judge(page, 'report-doc-390', { tap: false });
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
    await judge(page, 'settings-390', { tap: false });
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
});
