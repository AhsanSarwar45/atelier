import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * The terminal, driven the way a person drives it.
 *
 * Every other proof of this feature stops short of a real shell: the Rust tests
 * put bytes on a socket, and the bench tests hand the pane a `WebSocket` that is
 * not one. This is the case that presses the button in a browser, types into the
 * grid, and reads the answer the shell printed — so the whole run of it is under
 * test at once, from the click to the pseudo-terminal and back to the pixels.
 *
 * Needs an instance built from this worktree, because the shells live in the
 * server: `scripts/workbench-e2e.sh tests/e2e/terminal.spec.ts`.
 *
 * ## Why the whole file runs one test at a time
 *
 * A shell outlives the page that opened it, on purpose — that is the feature
 * case 4 proves. The other side of it is that a shell one case leaves behind is
 * a tab the next case finds already open, because the window fills itself from
 * `GET /api/terminal` before it starts anything new. So the cases go in order
 * and each one begins by closing every shell the instance is holding. Run them
 * side by side and they would be handing each other tabs.
 *
 * ## How the grid is read
 *
 * xterm draws through its DOM renderer here — no canvas or WebGL addon is
 * installed — so every visible row is a `div` of spans under `.xterm-rows`, and
 * the text of that container is what is on the screen. Only what is on the
 * screen: the scrollback above it is in xterm's buffer and not in the page, so
 * nothing below asserts on a line that has been scrolled off.
 *
 * ## How a canary is written
 *
 * A terminal echoes what is typed at it, so `echo HELLO` puts the word on the
 * screen before the shell has done anything at all — and a case that looked for
 * it would pass against a shell that never ran. Every canary here is therefore
 * split in the typing and whole in the answer: `'PH''ONE'` is two strings on the
 * line the shell echoes and one word in the line the shell prints, so finding
 * `PHONE[...]` is finding output and nothing else.
 */

/** Where the cases start: the project list, whose bar carries the button. */
const HOME = '/';

/** A shell is a whole process starting under a login profile; it is not instant. */
const SHELL_MS = 60_000;

/** How far the right edge is pulled in, in pixels — enough to change the width in characters beyond doubt. */
const PULLED_IN = 320;

/** A phone, in the sense the app means it: inside `(max-width: 639px)`. */
const PHONE = { width: 390, height: 844 };

declare global {
  interface Window {
    /** Every grid shape the panes have told their shells about, oldest first. */
    __shellShapes?: { url: string; cols: number; rows: number }[];
  }
}

/**
 * Listens in on the shape each pane sends its shell.
 *
 * How many characters wide the grid is, is worked out in the browser from the
 * size of the pane's own box — so the only honest source for what the shell
 * *should* report is the number the app itself measured and sent. This records
 * it on the way past without changing it: the same `send`, with the same
 * arguments, one frame later.
 */
function watchTheShapes(): void {
  const shapes: { url: string; cols: number; rows: number }[] = [];
  window.__shellShapes = shapes;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
    if (typeof data === 'string') {
      try {
        const said = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
        if (said?.type === 'resize' && typeof said.cols === 'number' && typeof said.rows === 'number') {
          shapes.push({ url: this.url, cols: said.cols, rows: said.rows });
        }
      } catch {
        // Text that is not our JSON is not ours to record.
      }
    }
    return send.call(this, data);
  };
}

/** One shell as `GET /api/terminal` says it. */
type Listed = { id: string; cwd: string; started: string; exited: boolean };

async function listShells(request: APIRequestContext): Promise<Listed[]> {
  const answer = await request.get('/api/terminal');
  expect(answer.ok(), `the instance would not list its shells: ${answer.status()}`).toBeTruthy();
  return (await answer.json()) as Listed[];
}

/**
 * Takes away every shell the instance is holding.
 *
 * The cross on a tab is the only way a person can do this, and it is the only
 * way anything else should either — so this goes through the same DELETE the
 * cross does rather than reaching past the server.
 */
async function closeEveryShell(request: APIRequestContext): Promise<void> {
  for (const shell of await listShells(request)) {
    await request.delete(`/api/terminal/${shell.id}`);
  }
}

/** What is drawn in one pane right now, as one run of text. */
async function drawn(pane: Locator): Promise<string> {
  return pane.evaluate((box) => (box.querySelector('.xterm-rows') ?? box).textContent ?? '');
}

/** Waits for something to appear in the grid, rather than for time to pass. */
async function drawsEventually(pane: Locator, wanted: RegExp, why: string, wait = SHELL_MS): Promise<string> {
  await expect.poll(() => drawn(pane), { message: why, timeout: wait }).toMatch(wanted);
  return drawn(pane);
}

/**
 * The window opened by the button, with a shell live in it.
 *
 * Waiting for the prompt rather than for the pane is the point: a pane is drawn
 * the moment the tab exists, and typing at a shell that has not finished
 * starting is how a case that reads its own echo comes to pass.
 */
async function openTerminal(page: Page): Promise<Locator> {
  await page.getByTestId('open-terminal').click();
  await expect(page.getByTestId('terminal-window'), 'the button did not open the window').toBeVisible({
    timeout: SHELL_MS,
  });
  const pane = page.getByTestId('terminal-pane').first();
  await expect(pane, 'the window opened with no grid in it').toBeVisible({ timeout: SHELL_MS });
  await drawsEventually(pane, /\S/, 'the shell never printed a prompt');
  return pane;
}

/** Types a line at whichever shell the pane is showing, and presses return. */
async function typeAt(page: Page, pane: Locator, line: string): Promise<void> {
  await pane.click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/** The last shape any pane on this page told its shell about. */
async function lastShape(page: Page): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate(() => {
    const shapes = window.__shellShapes ?? [];
    const last = shapes[shapes.length - 1];
    return last ? { cols: last.cols, rows: last.rows } : null;
  });
}

/**
 * The shape once the pane has stopped changing its mind.
 *
 * A pull settles in more than one step and honestly so: the grid is measured,
 * the lines in it reflow into the new width, that gives the viewport a
 * scrollbar it did not have, and the narrower box is measured again. Both
 * numbers are sent, and the shell ends up with the second — so asking it about
 * the first is asking about a shape that was true for one frame. Waited out by
 * how many have been sent rather than by a sleep: when no new one has arrived
 * between two looks, the pane is done.
 */
async function settledShape(page: Page): Promise<{ cols: number; rows: number }> {
  let before = -1;
  await expect
    .poll(
      async () => {
        const sent = await page.evaluate(() => window.__shellShapes?.length ?? 0);
        const done = sent > 0 && sent === before;
        before = sent;
        return done;
      },
      { message: 'the pane never stopped changing the shape of its grid', timeout: SHELL_MS, intervals: [300] },
    )
    .toBe(true);
  const shape = await lastShape(page);
  expect(shape, 'the pane told its shell no shape at all').not.toBeNull();
  return shape!;
}

test.describe.configure({ mode: 'serial' });

test.describe('the terminal', () => {
  test.beforeEach(async ({ page, request }) => {
    test.setTimeout(180_000);
    await closeEveryShell(request);
    await page.addInitScript(watchTheShapes);
  });

  test.afterEach(async ({ request }) => {
    await closeEveryShell(request);
  });

  test('the button in the bar opens a window with a live shell in it', async ({ page, request }) => {
    await page.goto(HOME);
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
    // Nothing before the press: the window is not in the page at all until a
    // shell has been asked for.
    await expect(page.getByTestId('terminal-window')).toHaveCount(0);

    const pane = await openTerminal(page);

    await expect(page.getByTestId('terminal-tab'), 'one press should open one tab').toHaveCount(1);
    await expect(pane).toBeVisible();

    // The grid on the screen is a shell the server is holding, not a drawing of
    // one: it answers.
    await typeAt(page, pane, `printf 'HEL''LO[%s]\\n' 7717`);
    const said = await drawsEventually(pane, /HELLO\[7717\]/, 'the shell did not answer the first thing typed at it');
    expect(said, 'the answer was drawn without the line that asked for it').toMatch(/HEL''LO/);

    const live = (await listShells(request)).filter((shell) => !shell.exited);
    expect(live, 'the server is not holding a shell for the tab on the screen').toHaveLength(1);
  });

  test('two tabs are two shells, and neither one answers the other', async ({ page }) => {
    await page.goto(HOME);
    const first = await openTerminal(page);

    await typeAt(page, first, `printf 'AL''PHA[%s]\\n' 7717`);
    await drawsEventually(first, /ALPHA\[7717\]/, 'the first shell never answered');

    await page.getByRole('button', { name: 'Open another shell' }).click();
    await expect(page.getByTestId('terminal-tab'), 'the plus did not add a tab').toHaveCount(2, {
      timeout: SHELL_MS,
    });

    const second = page.getByTestId('terminal-tab-body').nth(1).getByTestId('terminal-pane');
    await expect(second, 'the second tab has no grid').toBeVisible({ timeout: SHELL_MS });
    await drawsEventually(second, /\S/, 'the second shell never printed a prompt');
    await typeAt(page, second, `printf 'BR''AVO[%s]\\n' 4242`);

    const inSecond = await drawsEventually(second, /BRAVO\[4242\]/, 'the second shell never answered');
    expect(inSecond, "the second shell was given the first shell's answer").not.toMatch(/ALPHA\[7717\]/);

    // Two shells, and the server agrees there are two of them.
    const shells = await page.getByTestId('terminal-tab-body').evaluateAll((bodies) =>
      bodies.map((body) => body.getAttribute('data-shell')),
    );
    expect(new Set(shells).size, 'both tabs are drawing the same shell').toBe(2);

    await page.getByRole('tab').first().click();
    await expect(first, 'the first tab did not come back to the front').toBeVisible();
    const inFirst = await drawn(first);
    expect(inFirst, 'the first shell lost its own answer').toMatch(/ALPHA\[7717\]/);
    expect(inFirst, "the first shell was given the second shell's answer").not.toMatch(/BRAVO\[4242\]/);
  });

  test('a window pulled narrower gives the shell a narrower terminal', async ({ page }) => {
    await page.goto(HOME);
    const pane = await openTerminal(page);

    // The shape the app worked out for the window as it opened. Waited for
    // rather than assumed: it is sent when the pane has been laid out and the
    // socket is open, and neither is instant.
    const opened = await settledShape(page);

    const floating = page.getByTestId('terminal-window');
    const wide = await floating.boundingBox();
    expect(wide, 'the window is not on the screen to be pulled').not.toBeNull();

    const edge = page.getByTestId('terminal-window-resize-e');
    const grip = await edge.boundingBox();
    expect(grip, 'the window has no right edge to grab').not.toBeNull();
    const at = { x: grip!.x + grip!.width / 2, y: grip!.y + grip!.height / 2 };
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    // In steps, because the window follows a pointer rather than jumping to it,
    // and a single leap is a gesture no pointer ever makes.
    await page.mouse.move(at.x - PULLED_IN, at.y, { steps: 12 });
    await page.mouse.up();

    const narrow = await floating.boundingBox();
    expect(narrow!.width, 'the drag did not make the window narrower').toBeLessThan(wide!.width - PULLED_IN / 2);

    // The app measures its own box and tells the shell; that number, not a
    // guess at it, is what the shell is then asked to confirm.
    await expect
      .poll(() => lastShape(page).then((shape) => shape?.cols ?? null), {
        message: 'the narrower pane never told its shell a new width',
        timeout: SHELL_MS,
      })
      .not.toBe(opened.cols);
    const asked = await settledShape(page);
    expect(asked.cols, 'the app thinks a narrower window is a wider grid').toBeLessThan(opened.cols);

    // `stty size` and not `tput cols`: inside a command substitution `tput`
    // can answer out of the terminal description rather than out of the
    // window, and its answer for `xterm-256color` is eighty either way — which
    // is also the width the shell is opened at, so it would agree with a
    // resize that never happened.
    await typeAt(page, pane, `printf 'SI''ZE[%s]\\n' "$(stty size)"`);
    const said = await drawsEventually(pane, /SIZE\[\d+ \d+\]/, 'the shell never reported its size');
    const reported = /SIZE\[(\d+) (\d+)\]/.exec(said);
    const rows = Number(reported![1]);
    const cols = Number(reported![2]);

    // Nothing moved while the question was being asked, so the two numbers are
    // about the same grid and comparing them means something.
    expect(await lastShape(page), 'the pane reshaped the grid while the shell was being asked about it').toEqual(
      asked,
    );
    expect(
      cols,
      `the app measured the pulled-in pane at ${asked.cols} columns and the shell inside it says ${cols}`,
    ).toBe(asked.cols);
    expect(
      rows,
      `the app measured the pulled-in pane at ${asked.rows} rows and the shell inside it says ${rows}`,
    ).toBe(asked.rows);
  });

  test('a job left running is still running after the page is reloaded', async ({ page, request }) => {
    await page.goto(HOME);
    const pane = await openTerminal(page);
    const shellId = await page.getByTestId('terminal-tab-body').first().getAttribute('data-shell');
    expect(shellId, 'the tab does not say which shell it is drawing').toBeTruthy();

    // Backgrounded, so that "the shell still responds" can be asked of the same
    // shell the job is in rather than of a second one.
    await typeAt(page, pane, 'sleep 300 &');
    await drawsEventually(pane, /\[1\]\s+\d+/, 'the shell never started the job');

    await page.reload();
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });
    // The window is not part of the page's state and does not come back on its
    // own; the shells behind it are, and do.
    await expect(page.getByTestId('terminal-window'), 'a reload brought the window back with it').toHaveCount(0);

    await page.getByTestId('open-terminal').click();
    await expect(page.getByTestId('terminal-tab'), 'the reloaded page did not restore the tab').toHaveCount(1, {
      timeout: SHELL_MS,
    });
    const restored = page.getByTestId('terminal-tab-body').first();
    expect(
      await restored.getAttribute('data-shell'),
      'the reloaded page started a new shell instead of restoring the one it left',
    ).toBe(shellId);
    // And it is the server's list that it was restored from — the same id, said
    // by the endpoint the window asks.
    expect(
      (await listShells(request)).filter((shell) => !shell.exited).map((shell) => shell.id),
      'the server is not holding the shell the restored tab claims',
    ).toEqual([shellId]);

    const back = restored.getByTestId('terminal-pane');
    await expect(back).toBeVisible({ timeout: SHELL_MS });
    await drawsEventually(back, /\S/, 'the restored tab drew nothing at all');

    // `Running` is printed by `jobs` and appears nowhere in what was replayed,
    // so this is the live shell answering and the job is still in it.
    await typeAt(page, back, 'jobs');
    await drawsEventually(back, /Running\s+sleep 300/, 'the shell that survived the reload will not answer');
  });

  test.describe('on a phone', () => {
    test.use({ viewport: PHONE });

    test('the terminal takes the screen and the shell answers what is typed', async ({ page }) => {
      await page.goto(HOME);
      await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });

      const pane = await openTerminal(page);

      // A phone has no window to move or pull, so the window is the screen.
      const box = await page.getByTestId('terminal-window').boundingBox();
      expect(box!.width, 'the window is not the width of the phone').toBe(PHONE.width);
      expect(box!.height, 'the window is not the height of the phone').toBe(PHONE.height);
      await expect(
        page.getByTestId('terminal-window-resize-e'),
        'a phone was given an edge it cannot pull',
      ).toHaveCount(0);

      await typeAt(page, pane, `printf 'PH''ONE[%s]\\n' 4242`);

      const said = await drawsEventually(pane, /PHONE\[4242\]/, 'the shell on the phone never answered');
      expect(said, 'what was typed never reached the shell to be echoed back').toMatch(/PH''ONE/);
    });
  });
});
