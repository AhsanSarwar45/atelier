import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { makeFixtureProject } from './fixture-board';

/**
 * The board's row of column names, and who decides how tall it is (bw-e3dw.13).
 *
 * That row is the phone's way of saying which column you are looking at, and
 * each name in it was carrying `min-h-[40px]` of its own — the coarse-pointer
 * floor, copied down to the call site by hand. bw-e3dw.6 moved that floor to 44
 * in the one rule that owns it, and the copy stayed at 40.
 *
 * So this case asks the row two questions and takes both off the running app:
 *
 *  * on a screen you touch, is a name still 44px — the floor in `globals.css`,
 *    which is the only thing that should be answering;
 *  * with a mouse, is a name the height its own `size` asks for and nothing
 *    else — the same as any other `size="sm"` button on the same screen —
 *    rather than a number some call site added.
 *
 * And it checks the row is not drawn at all on a wide screen, which is why the
 * literal could not have been load-bearing there: the row is `sm:hidden`.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-board-column-tabs.spec.ts
 */

const STAGE = process.env.TABS_STAGE ?? 'now';
const SHOTS = `tests/results/the-board-column-tabs/${STAGE}`;
const WAIT = 60_000;

const PHONE = { width: 390, height: 844 };
/** Wide enough that `sm:` has taken over and the row is gone. */
const DESK = { width: 1100, height: 800 };
/** The floor a control is held to on a screen you touch. */
const TAP = 44;

// Each case is its own worker, so each writes its own line and the two files
// are read side by side.
const measured: string[] = [];
function note(what: string): void {
  measured.push(what);
}

function record(name: string): void {
  writeFileSync(`${SHOTS}/${name}`, measured.map((m) => `- ${m}`).join('\n') + '\n');
  // eslint-disable-next-line no-console
  console.log(`\n${measured.map((m) => `- ${m}`).join('\n')}\n`);
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

async function seeTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

/** Every name in the row, and how tall it is drawn. */
async function tabHeights(page: Page): Promise<number[]> {
  return page.locator('[data-testid="column-tabs"] button').evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().height)),
  );
}

test.describe('the board’s column names', () => {

  test.describe('on a phone', () => {
    test.use({ viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

    test('a column name is 44px because the stylesheet says so, not because the call site does', async ({ page, request }) => {
      test.setTimeout(300_000);
      // A board the app believes in: `bd init`, a manifest that says
      // `use_beads`, and three cards — without those the project has no Board
      // tab at all and there is no row of column names to measure.
      const run = join(__dirname, '..', '.workbench-run-board-tabs-touch');
      const fixture = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
      await seeTestProjects(page);
      const project = await fixtureProject(request, 'board-column-tabs', fixture);
      mkdirSync(SHOTS, { recursive: true });
      try {
        await page.goto(`/project?id=${project.id}&tab=board`);
        await page.waitForSelector('[data-testid="shell"]', { timeout: WAIT });
        await page.waitForTimeout(2500);
        await page.screenshot({ path: `${SHOTS}/00-phone-board.png`, animations: 'disabled' });
        await expect(page.getByTestId('column-tabs')).toBeVisible({ timeout: WAIT });
        const tall = await tabHeights(page);
        note(`a touch screen at ${PHONE.width}px: the column names are ${tall.join(', ')}px tall`);
        await page.screenshot({ path: `${SHOTS}/01-phone-touch.png`, animations: 'disabled' });
        expect(tall.length, 'no column names in the row').toBeGreaterThan(0);
        for (const h of tall) expect(h, `a column name is ${h}px on a touch screen`).toBeGreaterThanOrEqual(TAP);
      } finally {
        record('measurements-touch.txt');
        await request.delete(`/api/projects/${project.id}`).catch(() => {});
      }
    });
  });

  test.describe('with a mouse', () => {
    // The same narrow window, held by somebody with a pointer that is not a
    // thumb. This is the only place the call-site literal was ever visible.
    test.use({ viewport: PHONE, hasTouch: false, isMobile: false });

    test('a column name is the height its own size asks for, and nothing else', async ({ page, request }) => {
      test.setTimeout(300_000);
      const run = join(__dirname, '..', '.workbench-run-board-tabs-mouse');
      const fixture = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
      await seeTestProjects(page);
      const project = await fixtureProject(request, 'board-column-tabs-mouse', fixture);
      mkdirSync(SHOTS, { recursive: true });
      try {
        await page.goto(`/project?id=${project.id}&tab=board`);
        await expect(page.getByTestId('column-tabs')).toBeVisible({ timeout: WAIT });
        await page.waitForTimeout(1200);
        const tall = await tabHeights(page);
        // What `size="sm"` means, read off the app rather than written down
        // here: the row's own names are compared with the height the shared
        // control draws at that size, so this case moves if the size does.
        const sizeSm = await page.evaluate(() => {
          const probe = document.createElement('button');
          probe.className = 'h-8';
          probe.style.position = 'fixed';
          probe.style.visibility = 'hidden';
          document.body.append(probe);
          const h = Math.round(probe.getBoundingClientRect().height);
          probe.remove();
          return h;
        });
        note(`a mouse at ${PHONE.width}px: the column names are ${tall.join(', ')}px tall; \`size="sm"\` is ${sizeSm}px`);
        await page.screenshot({ path: `${SHOTS}/02-phone-mouse.png`, animations: 'disabled' });
        expect(tall.length, 'no column names in the row').toBeGreaterThan(0);
        for (const h of tall) {
          expect(h, `a column name is ${h}px with a mouse, where its size asks for ${sizeSm}px`).toBe(sizeSm);
        }

        // And on a wide screen the row is not drawn at all, which is why no
        // literal here could have been holding a wide layout up.
        await page.setViewportSize(DESK);
        await page.waitForTimeout(800);
        const drawn = await page.getByTestId('column-tabs').evaluate((el) => getComputedStyle(el).display);
        note(`a mouse at ${DESK.width}px: the row of column names is \`display: ${drawn}\``);
        expect(drawn, 'the row of column names is still drawn on a wide screen').toBe('none');
      } finally {
        record('measurements-mouse.txt');
        await request.delete(`/api/projects/${project.id}`).catch(() => {});
      }
    });
  });
});
