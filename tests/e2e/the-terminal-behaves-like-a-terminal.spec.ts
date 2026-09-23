import { expect, test, type APIRequestContext, type CDPSession, type Locator, type Page } from '@playwright/test';

/**
 * The terminal does what a desktop terminal's user expects without thinking.
 *
 * Copy and paste on Ctrl+Shift+C and Ctrl+Shift+V, a link opened with Ctrl
 * held, a finger on a phone scrolling the terminal and not the page, and a
 * wheel whose scrollbar agrees with what is on the screen. Each is proved in a
 * real browser against a real shell, because every one of them is the browser
 * and xterm negotiating over an event, and a bench stands in for both.
 *
 * Needs an instance built from this worktree:
 * `scripts/workbench-e2e.sh tests/e2e/the-terminal-behaves-like-a-terminal.spec.ts`.
 * Runs one case at a time for the reason `terminal.spec.ts` gives: a shell
 * outlives its page, so each case starts by closing every shell there is.
 *
 * Canaries are split in the typing and whole in the answer, as there: finding
 * `COPIED[5151]` is finding what the shell printed, never its echo.
 */

const HOME = '/';
const SHELL_MS = 60_000;
const PHONE = { width: 390, height: 844 };

/**
 * The lines in the buffer after `clear; seq 1 400`: the command, the four
 * hundred, the prompt that follows, and the line the cursor waits on.
 */
const LINES = 403;

type Listed = { id: string };

async function closeEveryShell(request: APIRequestContext): Promise<void> {
  const answer = await request.get('/api/terminal');
  for (const shell of (await answer.json()) as Listed[]) {
    await request.delete(`/api/terminal/${shell.id}`);
  }
}

async function drawn(pane: Locator): Promise<string> {
  return pane.evaluate((box) => (box.querySelector('.xterm-rows') ?? box).textContent ?? '');
}

async function drawsEventually(pane: Locator, wanted: RegExp, why: string): Promise<void> {
  await expect.poll(() => drawn(pane), { message: why, timeout: SHELL_MS }).toMatch(wanted);
}

async function openTerminal(page: Page, phone = false): Promise<Locator> {
  await page.goto(HOME);
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
  // A phone folds the button into the bar's menu.
  if (phone) {
    await page.getByTestId('shell-menu').click();
    await page.getByTestId('shell-menu-terminal').click();
  } else {
    await page.getByTestId('open-terminal').click();
  }
  const pane = page.getByTestId('terminal-pane').first();
  await expect(pane, 'the window opened with no grid in it').toBeVisible({ timeout: SHELL_MS });
  await drawsEventually(pane, /\S/, 'the shell never printed a prompt');
  return pane;
}

async function run(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/** The numbers `seq` printed that are on the screen right now, one per row. */
async function numbersShown(pane: Locator): Promise<number[]> {
  return pane.evaluate((box) =>
    [...box.querySelectorAll('.xterm-rows > div')]
      .map((row) => (row.textContent ?? '').trim())
      .filter((text) => /^\d+$/.test(text))
      .map(Number),
  );
}

/**
 * Where the scrollbar says the view is and where the rows say it is, each as a
 * share of the way from the top to the bottom. xterm draws its own scrollbar (a `.slider` in a
 * `.scrollbar.vertical` track), so the two can be read apart and compared.
 */
async function barAndView(pane: Locator, total: number): Promise<{ bar: number; view: number }> {
  return pane.evaluate((box, lines) => {
    const track = box.querySelector<HTMLElement>('.scrollbar.vertical');
    const slider = box.querySelector<HTMLElement>('.scrollbar.vertical > .slider');
    const rows = [...box.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').trim());
    const first = rows.findIndex((text) => /^\d+$/.test(text));
    if (!track || !slider || first < 0) return { bar: -1, view: -1 };
    // The first `seq` number on screen, less the rows above it, is the first
    // buffer line on screen — the buffer starts with the command line.
    // Both as a share of how far each can travel: the slider down the track
    // less its own length, the view down the buffer less the rows it shows.
    const top = Number(rows[first]) - first;
    return {
      bar: slider.offsetTop / (track.clientHeight - slider.offsetHeight),
      view: top / (lines - rows.length),
    };
  }, total);
}

test.describe.configure({ mode: 'serial' });

test.describe('the terminal behaves like a terminal', () => {
  test.beforeEach(async ({ request }) => {
    test.setTimeout(180_000);
    await closeEveryShell(request);
  });

  test.afterEach(async ({ request }) => {
    await closeEveryShell(request);
  });

  test('Ctrl+Shift+C copies the selection and Ctrl+Shift+V pastes it back', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const pane = await openTerminal(page);
    await run(page, `printf 'COP''IED[%s]\\n' 5151`);
    await drawsEventually(pane, /COPIED\[5151\]/, 'the shell never printed the line to copy');
    await page.evaluate(() => navigator.clipboard.writeText('nothing copied yet'));

    // A double click selects the word under it, as it does in any terminal.
    const word = pane.locator('.xterm-rows > div', { hasText: /^COPIED\[5151\]/ }).first();
    const box = (await word.boundingBox())!;
    await page.mouse.dblclick(box.x + 10, box.y + box.height / 2);
    await page.keyboard.press('Control+Shift+C');

    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), {
        message: 'Ctrl+Shift+C put nothing on the clipboard',
      })
      .toMatch(/^COPIED/);

    await page.evaluate(() => navigator.clipboard.writeText("printf 'PAS''TED[%s]\\n' 6161"));
    await pane.click();
    await page.keyboard.press('Control+Shift+V');
    await page.keyboard.press('Enter');
    await drawsEventually(pane, /PASTED\[6161\]/, 'Ctrl+Shift+V did not paste into the shell');

    await page.evaluate(() => navigator.clipboard.writeText("printf 'INS''ERTED[%s]\\n' 7171"));
    await page.keyboard.press('Shift+Insert');
    await page.keyboard.press('Enter');
    await drawsEventually(pane, /INSERTED\[7171\]/, 'Shift+Insert did not paste into the shell');
  });

  test('a link opens on Ctrl+click and not on a plain click', async ({ page, baseURL }) => {
    const pane = await openTerminal(page);
    const target = `${baseURL}/?from-terminal=1`;
    await run(page, `printf '%s\\n' '${target}'`);
    const row = pane.locator('.xterm-rows > div', { hasText: /^http.*from-terminal=1\s*$/ }).first();
    await expect(row, 'the shell never printed the link').toBeVisible({ timeout: SHELL_MS });
    const box = (await row.boundingBox())!;
    const at = { x: box.x + 20, y: box.y + box.height / 2 };

    let opened = 0;
    page.context().on('page', () => opened++);
    await page.mouse.move(at.x, at.y);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(500);
    expect(opened, 'a plain click on a link opened it').toBe(0);

    const popup = page.context().waitForEvent('page');
    await page.keyboard.down('Control');
    await page.mouse.move(at.x + 1, at.y);
    await page.mouse.click(at.x + 1, at.y);
    await page.keyboard.up('Control');
    expect((await popup).url()).toBe(target);
  });

  test('the scrollbar shows where the wheel has scrolled to', async ({ page }) => {
    const pane = await openTerminal(page);
    await run(page, 'clear; seq 1 400');
    await drawsEventually(pane, /400/, 'seq never finished');

    for (const turns of [-3, -8, 2, -20, 5]) {
      const box = (await pane.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < Math.abs(turns); i++) await page.mouse.wheel(0, Math.sign(turns) * 120);
      await page.waitForTimeout(400);
      const { bar, view } = await barAndView(pane, LINES);
      expect(bar, 'no scrollbar, or no numbers on screen').toBeGreaterThanOrEqual(0);
      expect(Math.abs(bar - view), `the bar reads ${bar.toFixed(3)} but the view is at ${view.toFixed(3)}`).toBeLessThan(
        0.01,
      );
    }
  });

  /**
   * The two ways xterm 6.0 leaves its bar behind the view (xtermjs/xterm.js#6172
   * and #6117): the window resized while scrolled back, and a tab hidden and
   * shown again. After either, the bar must still say where the view is, and
   * the next turn of the wheel must move the view by a turn and not jump it.
   */
  test('the scrollbar still agrees with the view after a resize and a tab switch', async ({ page }) => {
    const pane = await openTerminal(page);
    await run(page, 'clear; seq 1 400');
    await drawsEventually(pane, /400/, 'seq never finished');

    const wheel = async (turns: number): Promise<void> => {
      const box = (await pane.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < Math.abs(turns); i++) await page.mouse.wheel(0, Math.sign(turns) * 120);
      await page.waitForTimeout(400);
    };
    const agrees = async (why: string): Promise<void> => {
      const { bar, view } = await barAndView(pane, LINES);
      expect(bar, `${why}: no scrollbar, or no numbers on screen`).toBeGreaterThanOrEqual(0);
      expect(Math.abs(bar - view), `${why}: the bar reads ${bar.toFixed(3)}, the view is at ${view.toFixed(3)}`).toBeLessThan(
        0.01,
      );
    };

    await wheel(-10);
    await agrees('scrolled back');

    const edge = (await page.getByTestId('terminal-window-resize-s').boundingBox())!;
    const at = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x, at.y - 200, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    await agrees('after the window was made shorter');
    const before = Math.min(...(await numbersShown(pane)));
    await wheel(-1);
    const after = Math.min(...(await numbersShown(pane)));
    expect(before - after, 'one turn of the wheel after a resize jumped the view').toBeLessThan(15);
    expect(before - after, 'one turn of the wheel after a resize did not move the view').toBeGreaterThan(0);
    await agrees('a turn after the resize');

    await page.getByRole('button', { name: 'Open another shell' }).click();
    await expect(page.getByTestId('terminal-tab')).toHaveCount(2, { timeout: SHELL_MS });
    await page.getByRole('tab').first().click();
    await page.waitForTimeout(600);
    await agrees('after the tab was hidden and shown again');
    await wheel(-2);
    await agrees('a turn after the tab came back');
  });

  test.describe('on a phone', () => {
    test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

    test('a finger drag scrolls the terminal, not the page', async ({ page }) => {
      const pane = await openTerminal(page, true);
      await run(page, 'clear; seq 1 300');
      await drawsEventually(pane, /300/, 'seq never finished');
      const before = await numbersShown(pane);
      await page.evaluate(() => {
        (window as unknown as { __notReloaded: boolean }).__notReloaded = true;
      });
      const scrolled = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);

      const box = (await pane.boundingBox())!;
      const touch: CDPSession = await page.context().newCDPSession(page);
      const x = box.x + box.width / 2;
      const from = box.y + box.height * 0.3;
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from, id: 1 }] });
      for (let i = 1; i <= 10; i++) {
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: from + i * 30, id: 1 }],
        });
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

      await expect
        .poll(async () => Math.max(...(await numbersShown(pane))), {
          message: 'dragging down did not scroll the terminal back',
        })
        .toBeLessThan(Math.max(...before));
      expect(
        await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded),
        'the drag reloaded the page',
      ).toBe(true);
      expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0), 'the drag scrolled the page').toBe(
        scrolled,
      );
    });
  });
});
