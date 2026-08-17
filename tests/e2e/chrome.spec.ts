import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The chrome around the work: the bar's own controls, and the scrollbars.
 *
 * Two things are asserted here. The way out to settings is a control ON the
 * first bar — a child of it, centred on its row, inside its padding — and not a
 * button floated over the corner of the window, which is what it used to be.
 * And the scrollbars are the app's own: thin, no track, a thumb in the live
 * theme's ink.
 *
 * ⚠ The rail's WIDTH IN PIXELS cannot be read here. Headless chromium draws
 * overlay scrollbars — they take no room (offsetWidth - clientWidth is 0) and
 * never appear in a screenshot — and no launch flag turns that off. What is
 * read instead is what each PANE THAT SCROLLS resolves the two properties to,
 * which is exactly where the first attempt went wrong: the rule sat on the
 * document, `scrollbar-width` does not inherit, and every pane in the app was
 * left at the browser's default while the document — the one scroller this app
 * never uses — read thin. A picture of the rail itself comes from a browser
 * with a real window.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3031 BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
 *      npx playwright test tests/e2e/chrome.spec.ts
 */

async function projectId(request: APIRequestContext): Promise<string> {
  if (process.env.BEADS_E2E_PROJECT) return process.env.BEADS_E2E_PROJECT;
  const api = process.env.BEADS_E2E_BACKEND ?? '';
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as { id: string }[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return projects[0].id;
}

/**
 * Where the gear sits, measured against the bar and against the bar's OWN
 * controls.
 *
 * The row is taken from the back arrow, the project's name and the menu beside
 * it, not from the middle of the bar: a theme with a heavier bottom border sits
 * every control a pixel or two above that middle, and the claim is that the gear
 * is one of them.
 */
async function gearOnBar(page: Page) {
  return page.locator('a[aria-label="Settings"]').evaluate((el) => {
    const barEl = document.querySelector('[data-testid="project-bar"]')!;
    const centre = (n: Element) => {
      const r = n.getBoundingClientRect();
      return r.y + r.height / 2;
    };
    const others = [...barEl.querySelectorAll('a,button,h1,span')]
      .filter((n) => n !== el && !n.contains(el) && n.getBoundingClientRect().height > 0)
      .map(centre);
    const b = barEl.getBoundingClientRect();
    return {
      inBar: barEl.contains(el),
      position: getComputedStyle(el).position,
      theme: document.documentElement.getAttribute('data-theme'),
      /** How far the gear is off the row its neighbours sit on. */
      offRow: others.length ? Math.max(...others.map((c) => Math.abs(centre(el) - c))) : Math.abs(centre(el) - (b.y + b.height / 2)),
      neighbours: others.length,
      gearRight: el.getBoundingClientRect().right,
      barRight: b.right,
      barPadRight: parseFloat(getComputedStyle(barEl).paddingRight),
      scrollbarColor: getComputedStyle(document.documentElement).scrollbarColor,
    };
  });
}

test.describe('chrome', () => {
  test('the way out to settings is a control on the first bar, not floating over the screen', async ({
    page,
    request,
  }) => {
    const id = await projectId(request);

    for (const [where, url] of [
      ['the project list', '/'],
      ['the board', `/project?id=${id}&tab=board`],
    ] as const) {
      await page.goto(url);
      const bar = page.getByTestId('project-bar');
      await expect(bar).toBeVisible({ timeout: 30_000 });

      const gear = page.locator('a[aria-label="Settings"]');
      await expect(gear, `${where} has no way out to settings`).toBeVisible();

      const geometry = await gearOnBar(page);

      expect(geometry.inBar, `${where}: the gear is not inside the bar`).toBe(true);
      // A control taken out of the flow is the fault this case exists for: it
      // reads as belonging to no screen and lands off the bar's own row.
      expect(geometry.position, `${where}: the gear is taken out of the flow`).not.toBe('fixed');
      expect(geometry.position, `${where}: the gear is taken out of the flow`).not.toBe('absolute');
      expect(geometry.offRow, `${where}: the gear is off the row the bar's own controls sit on`).toBeLessThanOrEqual(1);
      // Inside the bar's padding, and at the end of it: the last thing on the row.
      expect(geometry.gearRight, `${where}: the gear overruns the bar's padding`).toBeLessThanOrEqual(
        geometry.barRight - geometry.barPadRight + 1,
      );
      expect(geometry.gearRight, `${where}: the gear is not at the end of the bar`).toBeGreaterThan(
        geometry.barRight - geometry.barPadRight - 40,
      );
    }
  });

  // A theme is free to give the bar a heavier border or its own type, and both
  // move the row the controls sit on. The gear has to move with them: it is one
  // of the bar's controls now, not a thing parked near it.
  for (const theme of ['catppuccin-latte', 'neo-brutalist'] as const) {
    test(`the gear keeps the bar's row under the ${theme} theme`, async ({ page, request }) => {
      const id = await projectId(request);
      await page.addInitScript((t) => localStorage.setItem('beads-theme', t), theme);
      await page.goto(`/project?id=${id}&tab=board`);
      await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('a[aria-label="Settings"]')).toBeVisible();

      const geometry = await gearOnBar(page);
      expect(geometry.theme, 'the theme did not take').toBe(theme);
      expect(geometry.inBar).toBe(true);
      expect(geometry.offRow, `${theme}: the gear is off the row the bar's own controls sit on`).toBeLessThanOrEqual(1);
      // The rail follows the theme too, and a theme that answers nothing would
      // leave the colour unparseable rather than merely different.
      expect(geometry.scrollbarColor, `${theme}: the rail is not in this theme's ink`).toMatch(
        /rgba?\(.+\)\s+rgba\([^)]*,\s*0\)/,
      );
    });
  }

  test('every pane that scrolls asks for the thin rail, not just the document', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=board`);
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 30_000 });
    // The board has to have something in it, or there is no pane to read.
    await expect.poll(() => page.getByTestId('column-scroll').count(), { timeout: 30_000 }).toBeGreaterThan(0);

    const rails = await page.evaluate(() => {
      const scrolls = [...document.querySelectorAll('*')].filter((e) => {
        const s = getComputedStyle(e);
        return (
          (/(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 4) ||
          (/(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 4)
        );
      });
      return scrolls.map((e) => {
        const s = getComputedStyle(e);
        return {
          what: e.getAttribute('data-testid') ?? e.tagName.toLowerCase(),
          width: s.scrollbarWidth,
          color: s.scrollbarColor,
        };
      });
    });

    // A screen with nothing overflowing proves nothing about rails.
    expect(rails.length, 'no pane on this screen overflows, so there is no rail to read').toBeGreaterThan(0);
    // This is the assertion the first attempt did not make: `scrollbar-width`
    // does not inherit, so a rule on the document leaves every one of these at
    // the browser's own width.
    const fat = rails.filter((r) => r.width !== 'thin');
    expect(fat, `panes left at the browser's own rail: ${JSON.stringify(fat.slice(0, 4))}`).toHaveLength(0);
    // Thumb and track, in that order — the track see-through, so the rail is a
    // thumb over the work rather than a column beside it.
    const wrongInk = rails.filter((r) => !/rgba?\(.+\)\s+rgba\([^)]*,\s*0\)/.test(r.color));
    expect(wrongInk, `panes not in the theme's ink: ${JSON.stringify(wrongInk.slice(0, 4))}`).toHaveLength(0);
  });
});
