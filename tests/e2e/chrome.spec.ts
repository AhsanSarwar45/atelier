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
 * ⚠ The rail cannot be MEASURED here. Headless chromium draws overlay
 * scrollbars — they take no room (offsetWidth - clientWidth is 0) and never
 * appear in a screenshot — and no launch flag turns that off. So what is
 * checked is what the page DECLARES: the two properties every browser now
 * reads, computed off the document, and the rail rules Chrome and Safari read,
 * found in the stylesheet the page actually loaded. A picture of the rail comes
 * from a real browser on a real screen.
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

      const geometry = await gear.evaluate((el) => {
        const barEl = document.querySelector('[data-testid="project-bar"]')!;
        const g = el.getBoundingClientRect();
        const b = barEl.getBoundingClientRect();
        return {
          inBar: barEl.contains(el),
          position: getComputedStyle(el).position,
          gearCentre: g.y + g.height / 2,
          barCentre: b.y + b.height / 2,
          gearRight: g.right,
          barRight: b.right,
          barPadRight: parseFloat(getComputedStyle(barEl).paddingRight),
        };
      });

      expect(geometry.inBar, `${where}: the gear is not inside the bar`).toBe(true);
      // A control taken out of the flow is the fault this case exists for: it
      // reads as belonging to no screen and lands off the bar's own row.
      expect(geometry.position, `${where}: the gear is taken out of the flow`).not.toBe('fixed');
      expect(geometry.position, `${where}: the gear is taken out of the flow`).not.toBe('absolute');
      expect(
        Math.abs(geometry.gearCentre - geometry.barCentre),
        `${where}: the gear is off the bar's row`,
      ).toBeLessThanOrEqual(1);
      // Inside the bar's padding, and at the end of it: the last thing on the row.
      expect(geometry.gearRight, `${where}: the gear overruns the bar's padding`).toBeLessThanOrEqual(
        geometry.barRight - geometry.barPadRight + 1,
      );
      expect(geometry.gearRight, `${where}: the gear is not at the end of the bar`).toBeGreaterThan(
        geometry.barRight - geometry.barPadRight - 40,
      );
    }
  });

  test('the app declares its own scrollbar: thin, no track, the theme’s ink', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=board`);
    await expect(page.getByTestId('project-bar')).toBeVisible({ timeout: 30_000 });

    const declared = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return { width: s.scrollbarWidth, color: s.scrollbarColor };
    });
    expect(declared.width, 'the rail is left at the browser default width').toBe('thin');
    expect(declared.color, 'the rail is left in the browser default colours').not.toBe('auto');
    // Thumb and track, in that order — and the track is see-through, so the
    // rail is a thumb on the work rather than a column beside it.
    expect(declared.color).toMatch(/rgba?\(.+\)\s+rgba\([^)]*,\s*0\)/);

    // Chrome and Safari take their width from their own rail parts, so those
    // have to be in the stylesheet as well.
    const css = await styleText(page);
    expect(css, 'the stylesheet carries no rail rules for Chrome and Safari').toContain('::-webkit-scrollbar-thumb');
    const thumb = /::-webkit-scrollbar-thumb\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    // The paint is clipped inside a transparent border: that is what draws a
    // hairline thumb with air either side of it instead of a full-width block.
    expect(thumb, 'the thumb fills the whole rail').toContain('content-box');
    expect(thumb, 'the thumb has no inset').toMatch(/border:\s*3px\s+solid\s+(transparent|rgba\(0,\s*0,\s*0,\s*0\))/);
    const rail = /::-webkit-scrollbar\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rail, 'the rail is left at the browser default width').toMatch(/width:\s*10px/);
    const track = /::-webkit-scrollbar-track[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(track, 'the rail still draws a track behind the thumb').toMatch(/transparent|rgba\(0,\s*0,\s*0,\s*0\)/);
  });
});
