import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';

import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The phone faults of bw-ad3r, driven at a phone and photographed.
 *
 * Each of the four cards this case covers was a thing a person holding the app
 * in one hand could not do at all, and each is asked here the way they asked
 * it: with a tap, at 390x844, with a picture kept of the answer.
 *
 *   bw-ad3r.5  the chooser was `display: none`, so the paperclip reached
 *              nothing on a phone — a browser will not open its chooser for a
 *              control that was never laid out.
 *   bw-ad3r.7  a file that is not a picture now goes into the writing box as a
 *              fenced block naming it, rather than being turned away.
 *   bw-ad3r.10 a running command could only be stopped with a Ctrl key, which a
 *              phone does not have; the strip carries the interrupt now.
 *   bw-ad3r.14 scrolling back announced every page, so the notice blinked on
 *              and off at every flick; it waits 450ms now and a fast page
 *              therefore never says a word.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-phone-can-send-and-stop.spec.ts
 *
 * The viewport, the touch flags and the thumb floor are the-app-on-a-phone's,
 * and the reach probe below is the same arithmetic as that file's `outOfReach`:
 * what answers a press, measured at the half pixel from the control's own
 * middle, rather than the painted box.
 */

const PHONE = { width: 390, height: 844 };
const THUMB = 44;
const WAIT = 60_000;
const SHELL_MS = 60_000;

const SHOTS = join(process.cwd(), 'tests', 'results', 'a-phone-can-send-and-stop');
const PICTURE = join(__dirname, '..', 'fixtures', 'files-preview', 'shot.png');

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
// A shell outlives the page that opened it and a chat fixture routes the whole
// socket, so these three do not share a browser.
test.describe.configure({ mode: 'serial' });

const shots: string[] = [];

async function shoot(page: Page, name: string): Promise<void> {
  const path = join(SHOTS, `${name}.png`);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path, animations: 'disabled' });
  shots.push(path);
}

/**
 * How far a press answers for this control, measured out from its own middle.
 *
 * The same probe the-app-on-a-phone.spec.ts judges every screen with: a box
 * forty-four across is hit at 0.5 through 43.5 and reads back as forty-four.
 */
async function reach(control: Locator, floor: number): Promise<{ wide: number; tall: number; painted: string }> {
  return control.evaluate((el, want) => {
    const box = el.getBoundingClientRect();
    const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const answers = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
      const on = document.elementFromPoint(x, y);
      return Boolean(on && (on === el || el.contains(on) || on.contains(el)));
    };
    const far = (dx: number, dy: number): number => {
      let got = 0;
      for (let step = 0.5; step <= want; step += 1) {
        if (!answers(middle.x + dx * step, middle.y + dy * step)) return got;
        got = step + 0.5;
      }
      return got;
    };
    return {
      wide: far(-1, 0) + far(1, 0),
      tall: far(0, -1) + far(0, 1),
      painted: `${Math.round(box.width)}x${Math.round(box.height)}`,
    };
  }, floor);
}

// ---------------------------------------------------------------------------
// 1 and 2: the paperclip, a picture, and a file that is not one.
// ---------------------------------------------------------------------------

const CHAT = 'a-phone-can-send-and-stop';
const FIXTURE = join(process.cwd(), 'tests', '.workbench-run-a-phone-can-send-and-stop');
const NOTES = join(FIXTURE, 'notes.txt');
const NOTES_TEXT = 'the first line of the attached file\nthe second line of it\n';

test('a tap on the paperclip opens a chooser, and both a picture and a file land in the composer', async ({ page, request }) => {
  test.setTimeout(180_000);
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(NOTES, NOTES_TEXT);

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  const made = await request.post('/api/projects', {
    data: { name: 'a-phone-can-send-and-stop', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: FIXTURE, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'session.menu', commands: [], skills: [], models: [], permissionModes: ['on-request', 'plan'], collaborationModes: [], efforts: [], agentDefinitions: [], configOptions: [], agentControls: [] },
    { ...base, seq: 3, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') !== chat) return;
        setTimeout(() => this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
        })), 0);
      }
      close() {}
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, view: foldAll(events) });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({
    json: { sessionId: CHAT, origin: 'app', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'A phone attaches a file', cwd: FIXTURE, beads: [] },
  }));

  try {
    await page.goto(`/project?id=${project.id}&chat=${CHAT}`);
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: WAIT });
    await expect(page.getByTestId('composer-frame')).toBeVisible({ timeout: WAIT });

    // ---- The property whose absence broke phones. ----------------------
    // A control that is not laid out is one a phone browser will not open its
    // chooser for (bw-ad3r.5). So the input is asked for a box, and the box is
    // asked to be a real one: laid out, and not `display: none`.
    const input = page.getByTestId('image-input');
    await expect(input).toHaveCount(1);
    const laidOut = await input.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return {
        display: getComputedStyle(el).display,
        boxes: el.getClientRects().length,
        width: box.width,
        height: box.height,
      };
    });
    expect(laidOut.display, 'the chooser must not be display:none — a phone opens no chooser for a control with no box').not.toBe('none');
    expect(laidOut.boxes, 'the chooser must really be laid out').toBeGreaterThan(0);
    expect(laidOut.width, 'the chooser must have a width').toBeGreaterThan(0);
    expect(laidOut.height, 'the chooser must have a height').toBeGreaterThan(0);
    const box = await input.boundingBox();
    expect(box, 'the chooser has a bounding box').not.toBeNull();
    expect(box!.width * box!.height, 'and the box is not an empty one').toBeGreaterThan(0);

    // ---- A tap is what opens it. ---------------------------------------
    // Not setInputFiles: that reaches past the button and would pass against
    // the very fault this card fixed. A real system chooser cannot be opened
    // in a browser under test, so what is proved is everything up to it —
    // that the tap activated THIS input and the browser began asking for
    // files — and the files are then handed to the chooser the tap opened.
    const attach = page.getByTestId('attach-picture');
    await expect(attach).toBeVisible();
    const chooser = page.waitForEvent('filechooser', { timeout: WAIT });
    await attach.tap();
    const asked = await chooser;
    const whoAsked = await asked.element().evaluate((el) => ({
      testid: el.getAttribute('data-testid'),
      multiple: (el as HTMLInputElement).multiple,
    }));
    expect(whoAsked.testid, 'the tap on the paperclip is what opened the chooser, and it opened the composer\'s own input').toBe('image-input');
    expect(whoAsked.multiple, 'and it asks for as many files as a person wants to attach').toBe(true);

    await asked.setFiles(PICTURE);
    await expect(page.getByTestId('attachment-tray')).toBeVisible({ timeout: WAIT });
    await expect(page.getByTestId('attachment-thumb')).toBeVisible({ timeout: WAIT });
    await expect(page.getByTestId('composer-image-badge')).toHaveText('shot.png', { timeout: WAIT });
    await shoot(page, '01-a-tap-attached-a-picture');

    // ---- 2. A file that is not a picture. ------------------------------
    // Through the same input, by the same tap: what it leaves behind is words
    // in the writing box, which is what the person sends (bw-ad3r.7).
    const again = page.waitForEvent('filechooser', { timeout: WAIT });
    await attach.tap();
    await (await again).setFiles(NOTES);
    const written = page.getByTestId('composer');
    await expect.poll(() => written.inputValue(), { timeout: WAIT }).toContain('notes.txt:');
    const draft = await written.inputValue();
    expect(draft, 'the file goes in as a fenced block named after itself, fenced by its own kind').toContain(
      'notes.txt:\n```txt\nthe first line of the attached file\nthe second line of it\n```',
    );
    await expect(page.getByTestId('send-error'), 'and nothing was refused').toHaveCount(0);
    // The picture is still attached beside it: one tray, two kinds of thing.
    await expect(page.getByTestId('attachment-thumb')).toBeVisible();
    await shoot(page, '02-a-file-became-a-fenced-block');
  } finally {
    await request.delete(`/api/projects/${project.id}`).catch(() => undefined);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3: the key that stops what is running.
// ---------------------------------------------------------------------------

test('a phone can stop a running command from the strip', async ({ page, request }) => {
  test.setTimeout(240_000);
  const shells = async () => (await (await request.get('/api/terminal')).json()) as { id: string }[];
  const closeEveryShell = async () => {
    for (const shell of await shells()) await request.delete(`/api/terminal/${shell.id}`);
  };
  await closeEveryShell();

  const drawn = (pane: Locator) => pane.evaluate((el) => (el.querySelector('.xterm-rows') ?? el).textContent ?? '');

  try {
    await page.goto('/');
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: WAIT });
    await page.getByTestId('open-terminal').tap();
    await expect(page.getByTestId('terminal-window'), 'the button did not open the window').toBeVisible({ timeout: SHELL_MS });
    const pane = page.getByTestId('terminal-pane').first();
    await expect(pane).toBeVisible({ timeout: SHELL_MS });
    await expect.poll(() => drawn(pane), { message: 'the shell never printed a prompt', timeout: SHELL_MS }).toMatch(/\S/);

    // ---- The key is there, and a thumb can hit it. ---------------------
    const key = page.getByTestId('terminal-interrupt');
    await expect(key, 'a phone has no Ctrl key, so the strip must carry one').toBeVisible();
    await expect(key).toBeEnabled();
    const hit = await reach(key, THUMB);
    const around = await key.evaluate((el) => {
      const holder = el.parentElement!;
      const strip = el.closest('[role="tablist"]') as HTMLElement | null;
      const of = (box: DOMRect) => ({ w: Math.round(box.width), h: Math.round(box.height) });
      return {
        holder: of(holder.getBoundingClientRect()),
        strip: strip ? of(strip.getBoundingClientRect()) : null,
      };
    });
    console.log(
      `the interrupt key answers ${hit.wide}x${hit.tall} (painted ${hit.painted}); its holder is ${around.holder.w}x${around.holder.h} and the strip is ${around.strip?.w}x${around.strip?.h}`,
    );
    const thumbable = (hit.wide >= THUMB && hit.tall >= THUMB)
      || (hit.wide >= THUMB && around.strip !== null && around.strip.h >= THUMB);
    expect(
      thumbable,
      `the interrupt key must be hittable by a thumb: it answers ${hit.wide}x${hit.tall} (painted ${hit.painted}) inside a ${around.strip?.h}px strip, against a ${THUMB}px floor`,
    ).toBe(true);

    // ---- And it really stops what is running. --------------------------
    // A shell holding a 45 second sleep answers nothing typed at it, so a
    // canary printed after the tap is the interrupt having landed and not the
    // terminal merely echoing.
    await pane.tap();
    await page.keyboard.type('sleep 45');
    await page.keyboard.press('Enter');
    await expect.poll(() => drawn(pane), { message: 'the shell never took the command', timeout: SHELL_MS }).toMatch(/sleep 45/);
    await shoot(page, '03-the-terminal-with-its-interrupt-key');

    await key.tap();
    await pane.tap();
    await page.keyboard.type(`printf 'ST''OPPED[%s]\\n' 1`);
    await page.keyboard.press('Enter');
    await expect
      .poll(() => drawn(pane), { message: 'the tap did not stop the sleep: the shell was still busy', timeout: SHELL_MS })
      .toMatch(/STOPPED\[1\]/);
    await shoot(page, '04-the-tap-stopped-what-was-running');
  } finally {
    await closeEveryShell();
  }
});

// ---------------------------------------------------------------------------
// 4: scrolling back says nothing when the page is quick.
// ---------------------------------------------------------------------------

test('scrolling back through a long chat on a phone announces nothing', async ({ page, request }) => {
  test.setTimeout(180_000);
  const externalId = '77777777-7777-4777-8777-aaaaaaaaaaaa';
  const fixture = join(process.cwd(), 'tests', '.workbench-run-a-phone-scrolls-back');
  // The official Agent SDK's sanitized project-directory layout, as
  // claude-history-scroll.spec.ts writes it.
  const projectKey = Array.from(fixture, (character) => {
    const code = character.charCodeAt(0);
    const alphaNumeric = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122);
    return alphaNumeric ? character : '-';
  }).join('');
  const recordDir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', projectKey);
  const record = join(recordDir, `${externalId}.jsonl`);
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  mkdirSync(recordDir, { recursive: true });
  let parent: string | null = null;
  const rows: Record<string, unknown>[] = [];
  for (let turn = 0; turn < 45; turn += 1) {
    const user = `user-${turn}`;
    const assistant = `assistant-${turn}`;
    rows.push({
      type: 'user', sessionId: externalId, uuid: user, parentUuid: parent, cwd: fixture,
      timestamp: `2026-09-02T05:${String(turn).padStart(2, '0')}:00.000Z`,
      ...(turn === 0 ? { customTitle: 'A long chat read on a phone' } : {}),
      message: { role: 'user', content: `Prompt ${turn}` },
    });
    rows.push({
      type: 'assistant', sessionId: externalId, uuid: assistant, parentUuid: user, cwd: fixture,
      timestamp: `2026-09-02T05:${String(turn).padStart(2, '0')}:30.000Z`,
      message: { id: `answer-${turn}`, role: 'assistant', content: [{ type: 'text', text: `Answer ${turn}` }] },
    });
    parent = assistant;
  }
  writeFileSync(record, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const made = await request.post('/api/projects', { data: { name: 'a phone scrolls back', path: fixture } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  let olderRequests = 0;
  let slowest = 0;
  await page.route('**/api/workbench/history?*', async (route) => {
    if (!new URL(route.request().url()).searchParams.has('before')) return route.continue();
    olderRequests += 1;
    // A deliberately held window, well inside the 450ms the notice waits, so
    // the screenshot below is taken while the page really is in flight and the
    // absence of a banner is the absence of a banner and not a race.
    const began = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
    slowest = Math.max(slowest, Date.now() - began);
  });

  try {
    await page.goto(`/project?id=${project.id}&tab=chat`);
    // On a phone the list of chats is a drawer over the conversation, so the
    // way to a chat is to open it first (bw-e3dw.2).
    const row = page.locator(`[data-testid="restore-row"][data-external-id="${externalId}"]`);
    await expect(row).toBeAttached({ timeout: WAIT });
    if (!(await row.getByTestId('row-name').isVisible()) || !(await row.getByTestId('row-name').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.right > 0 && box.left < window.innerWidth;
    }))) {
      await page.getByTestId('chat-rail-toggle').tap();
      await expect(row.getByTestId('row-name')).toBeInViewport({ timeout: WAIT });
    }
    await row.getByTestId('row-name').tap();
    await expect(page.getByTestId('chat-loading')).toBeHidden({ timeout: WAIT });
    const pane = page.getByTestId('transcript');
    const transcript = page.getByTestId('virtual-transcript');
    await expect(transcript).toHaveAttribute('data-loaded-items', '40', { timeout: WAIT });
    await expect(transcript).toHaveAttribute('data-can-load-older', 'true');

    // Watching for the notice rather than sampling for it: a banner that
    // appeared for one frame between two polls would otherwise go unseen, and
    // this case is about the reader catching a flicker.
    await page.evaluate(() => {
      const seen = { ever: 0 };
      (window as typeof window & { __banner?: { ever: number } }).__banner = seen;
      const look = () => {
        if (document.querySelector('[data-testid="older-loading"]')) seen.ever += 1;
      };
      look();
      new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
    });

    await pane.hover();
    await page.mouse.wheel(0, -10_000);
    // Mid-flight: the page has been asked for and has not arrived.
    await expect.poll(() => olderRequests, { timeout: WAIT }).toBe(1);
    await shoot(page, '05-scrolled-back-with-no-banner');
    await expect(page.getByTestId('older-loading'), 'a quick page says nothing while it is in flight').toHaveCount(0);

    await expect.poll(async () => Number(await transcript.getAttribute('data-loaded-items')), { timeout: WAIT }).toBeGreaterThan(40);
    await expect(page.getByTestId('older-loading'), 'and nothing once it has arrived either').toHaveCount(0);
    const banner = await page.evaluate(() => (window as typeof window & { __banner?: { ever: number } }).__banner?.ever ?? -1);
    console.log(`the older page took at least ${slowest}ms to arrive, and the notice was drawn ${banner} times`);
    expect(banner, 'the notice waits 450ms, so a page this quick never draws it at all (bw-ad3r.14)').toBe(0);
    // And the older rows really are there: a notice that never appears because
    // nothing ever loaded would prove nothing. The window grew above, and the
    // chat is still the one it was — the page joined on rather than replacing.
    await expect(page.getByTestId('user-message').first()).toBeVisible({ timeout: WAIT });
    await shoot(page, '06-the-older-page-arrived-silently');
  } finally {
    await request.delete(`/api/projects/${project.id}`).catch(() => undefined);
    rmSync(fixture, { recursive: true, force: true });
    rmSync(record, { force: true });
    console.log(['', 'Pictures:', ...shots.map((one) => `   ${one}`), ''].join('\n'));
  }
});
