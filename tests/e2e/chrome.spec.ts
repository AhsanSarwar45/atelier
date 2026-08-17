import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The chrome around the work: the bar's own controls, and the scrollbars.
 *
 * Two things are asserted here. The way out to settings is a control ON the
 * first bar — a child of it, centred on its row, inside its padding — and not a
 * button floated over the corner of the window, which is what it used to be.
 * And the scrollbars are the app's own: a 6px hairline, no track, a thumb at a
 * quarter of the theme's muted ink.
 *
 * ⚠ The rail's WIDTH IN PIXELS is only there to read in a browser with a real
 * window. Headless chromium draws overlay rails — they take no room
 * (offsetWidth - clientWidth is 0) and never appear in a screenshot — under
 * every launch flag tried. So the width is measured when the run has it and the
 * rules are read when it does not, and `scripts/rail-in-a-real-window.mjs` is
 * the run that has it.
 *
 * The two ways of asking for a rail are exclusive, which is the thing these
 * cases exist to hold: Chrome and Safari draw `::-webkit-scrollbar…` and ignore
 * every one of those rules for any element whose `scrollbar-width` or
 * `scrollbar-color` is set, while Firefox draws only those two properties. A
 * well-meant `* { scrollbar-width: thin }` therefore takes Chrome's hairline
 * away and hands back a 10px default — so the absence of those properties
 * outside the Firefox-only block is asserted, not just the presence of the
 * rules.
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
      gearInk: getComputedStyle(el).color,
    };
  });
}

/** Every rule in every stylesheet the page loaded, as one piece of text. */
async function styleText(page: Page): Promise<string> {
  return page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText);
        } catch {
          // A sheet from another origin cannot be read; this app serves its own.
          return [];
        }
      })
      .join('\n'),
  );
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
      // The gear's own ink comes from the theme, so a theme that answers nothing
      // would leave it unset rather than merely different.
      expect(geometry.gearInk, `${theme}: the gear has no ink of its own`).toMatch(/rgba?\(/);
    });
  }

  /**
   * Every theme, not a sample: the gear is inked from the app's own text scale,
   * which all eleven spell out. The button's quiet variants are written in the
   * borrowed vocabulary (`muted-foreground`, `accent-foreground`) that three of
   * the themes never define, and on those three a control wearing one silently
   * falls back to a fixed palette. Nothing on screen says so — which is why this
   * is checked by reading the ink against the theme's own value rather than by
   * looking at it.
   */
  test('the gear is inked by every one of the eleven themes, not by a fallback', async ({ page, request }) => {
    const id = await projectId(request);
    const themes = [
      null,
      'glassmorphism',
      'neo-brutalist',
      'linear-minimal',
      'soft-light',
      'notion-warm',
      'github-clean',
      'catppuccin-latte',
      'catppuccin-frappe',
      'catppuccin-macchiato',
      'catppuccin-mocha',
    ] as const;

    await page.goto(`/project?id=${id}&tab=board`);
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 30_000 });

    const off: string[] = [];
    for (const theme of themes) {
      // The theme is picked up on load, so it is stored and the screen reloaded
      // rather than poked onto the document: the ink is read the way a reader
      // gets it, not the way a script can force it.
      await page.evaluate((t) => {
        if (t) localStorage.setItem('beads-theme', t);
        else localStorage.removeItem('beads-theme');
      }, theme);
      await page.reload();
      await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('a[aria-label="Settings"]')).toBeVisible();

      const ink = await page.locator('a[aria-label="Settings"]').evaluate((el) => {
        // What the live theme says its third-level text is, resolved to the
        // same rgb() the browser reports for the gear.
        const probe = document.createElement('span');
        probe.style.color = `hsl(${getComputedStyle(document.documentElement).getPropertyValue('--text-tertiary').trim()})`;
        document.body.appendChild(probe);
        const wanted = getComputedStyle(probe).color;
        probe.remove();
        return { theme: document.documentElement.dataset.theme ?? '(default)', got: getComputedStyle(el).color, wanted };
      });

      if (ink.got !== ink.wanted) off.push(`${ink.theme}: gear ${ink.got}, theme ${ink.wanted}`);
    }

    expect(off, `themes the gear does not take its ink from: ${off.join('; ')}`).toHaveLength(0);
  });

  test('every pane that scrolls gets the app’s hairline, and nothing switches it off', async ({ page, request }) => {
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
      return {
        knowsRailParts: CSS.supports('selector(::-webkit-scrollbar)') && !CSS.supports('(-moz-orient: inline)'),
        panes: scrolls.map((e) => {
          const s = getComputedStyle(e);
          return {
            what: e.getAttribute('data-testid') ?? e.tagName.toLowerCase(),
            across: e.offsetWidth - e.clientWidth,
            down: e.offsetHeight - e.clientHeight,
            width: s.scrollbarWidth,
            color: s.scrollbarColor,
          };
        }),
      };
    });

    // A screen with nothing overflowing proves nothing about rails.
    expect(rails.panes.length, 'no pane on this screen overflows, so there is no rail to read').toBeGreaterThan(0);

    if (rails.knowsRailParts) {
      // Chrome and Safari: the rail parts draw, and they only draw while
      // neither property is set. A pane whose properties are set has silently
      // gone back to the browser's own 10px — which is what shipped once.
      const switchedOff = rails.panes.filter((r) => r.width !== 'auto' || r.color !== 'auto');
      expect(
        switchedOff,
        `panes whose rail parts are switched off by the two properties: ${JSON.stringify(switchedOff.slice(0, 4))}`,
      ).toHaveLength(0);
    } else {
      // Firefox: the properties are the only way, and the width does not
      // inherit — so every pane has to carry them, not just the document.
      const fat = rails.panes.filter((r) => r.width !== 'thin');
      expect(fat, `panes left at the browser's own rail: ${JSON.stringify(fat.slice(0, 4))}`).toHaveLength(0);
      const wrongInk = rails.panes.filter((r) => !/rgba?\(.+\)\s+rgba\([^)]*,\s*0\)/.test(r.color));
      expect(wrongInk, `panes not in the theme's ink: ${JSON.stringify(wrongInk.slice(0, 4))}`).toHaveLength(0);
    }

    // Where the run has real rails, the hairline is measured rather than
    // inferred. Overlay rails report 0 and are simply not evidence.
    const measured = rails.panes.filter((r) => r.across > 0 || r.down > 0);
    for (const r of measured) {
      expect(Math.max(r.across, r.down), `${r.what} draws a rail wider than a hairline`).toBeLessThanOrEqual(6);
    }

    // And the rules themselves, which is all a windowless run can see.
    const css = await styleText(page);
    const rail = /::-webkit-scrollbar\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rail, 'the rail parts do not ask for a hairline').toMatch(/width:\s*6px/);
    expect(rail, 'the sideways rail is not the same hairline').toMatch(/height:\s*6px/);
    const track = /::-webkit-scrollbar-track[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(track, 'the rail draws a track behind the thumb').toMatch(/transparent|rgba\(0,\s*0,\s*0,\s*0\)/);
    const thumb = /::-webkit-scrollbar-thumb\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    // A quarter strength or fainter: the manager's own word for it was 'present'.
    const alpha = Number(/\/\s*(0?\.\d+)\s*\)/.exec(thumb)?.[1] ?? /,\s*(0?\.\d+)\s*\)/.exec(thumb)?.[1] ?? '1');
    expect(alpha, `the thumb is louder than a quarter of the theme's muted ink: ${thumb.trim()}`).toBeLessThanOrEqual(
      0.25,
    );
    // The properties exist for Firefox and must stay behind its own gate: loose
    // in the stylesheet, they take the hairline away from Chrome and Safari.
    const looseWidth = /(^|[^-])scrollbar-width\s*:/.test(css.replace(/@supports \(-moz-orient[^{]*\{[\s\S]*?\}\s*\}/g, ''));
    expect(looseWidth, 'scrollbar-width is set outside the Firefox-only block, which switches off the hairline').toBe(
      false,
    );
  });
});
