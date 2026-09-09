import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * A thumb, and the `@` menu with a keyboard up (bw-e3dw.6).
 *
 * The survey (bw-e3dw.1) measured both faults and this case is what the fixes
 * are proved by. It drives the real app at 390x844 with touch and asks two
 * things:
 *
 *  * is every control a finger is meant to hit at least 44 pixels across —
 *    measured as the area a thumb centred on it actually lands on, so a
 *    checkbox that keeps a small painted box and grows an invisible target
 *    answers honestly;
 *  * with the keyboard up, is the composer's `@` completion list drawn where
 *    it can be read and tapped. The keyboard is not something a headless
 *    browser has, and it does not change `window.innerHeight` on a real phone
 *    either — `window.visualViewport` is what says where it is, so that is
 *    what this case moves, and the app is asked to answer to it.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-thumb-and-the-at-menu.spec.ts
 */

const STAGE = process.env.THUMB_STAGE ?? 'now';
const SHOTS = `tests/results/thumb-and-at-menu/${STAGE}`;
const WAIT = 60_000;
const CHAT = 'thumb-at-menu-chat';

const PHONE = { width: 390, height: 844 };
/** What a phone keyboard takes off the bottom of a 844px screen. */
const KEYBOARD = 336;
/** The floor a control is held to on a screen you touch. */
const TAP = 44;

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

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
  writeFileSync(join(where, 'README.md'), '# Read on a phone\n\nA paragraph.\n');
  writeFileSync(join(where, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(join(where, 'src', 'lib', 'deep.ts'), 'export const deep = 1;\n');
  writeFileSync(join(where, 'src', 'lib', 'later.ts'), 'export const later = 2;\n');

  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'A Thumb');
  git(where, 'config', 'user.email', 'thumb@atelier.test');
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

/**
 * Every control a thumb is meant to hit, and how big its target really is.
 *
 * Not `getBoundingClientRect`: a checkbox keeps a sixteen-pixel painted box on
 * every screen and grows an invisible one around it, which is the right answer
 * and the wrong measurement. So each control is probed outward from its own
 * centre with `elementFromPoint` — the question a finger asks — and what comes
 * back is how far the target reaches each way.
 */
async function tooSmall(page: Page, floor: number): Promise<string[]> {
  return page.evaluate((floor) => {
    const controls =
      'button, a[href], [role="button"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), select, textarea, [role="switch"], [role="checkbox"]';
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll(controls))) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      // A control inside a sentence is part of the sentence, and the rule that
      // floors everything else deliberately does not reach an inline box.
      if (style.display === 'inline') continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      // A control inside another control is one target, not two.
      if (el.parentElement?.closest(controls)) continue;

      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      // What lands on the control and nothing else. An ancestor answering at
      // that point is the gap BETWEEN two buttons, not either of them, so a
      // hit is the element itself or something drawn inside it — which is also
      // how an invisible `::before` target answers, in its owner's name.
      //
      // A label around it counts too: a tick with its words beside it is
      // toggled by the words, so the line they share is the target and not the
      // sixteen pixels of box. The case proves that separately, by pressing the
      // words and watching the tick.
      const label = el.closest('label');
      const mine = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
        const on = document.elementFromPoint(x, y);
        return on !== null && (el.contains(on) || (label !== null && label.contains(on)));
      };
      // How far the target reaches from its own centre, out to the floor and
      // no further: nothing here needs to know that a bar is 300px wide.
      // Probed at the half pixel, so what comes back is a width and not a
      // count of points: a box forty-four across is hit at 0.5 through 43.5
      // from its own centre and reads back as forty-four.
      const reach = (dx: number, dy: number) => {
        let far = 0;
        for (let step = 0.5; step <= floor; step += 1) {
          if (!mine(cx + dx * step, cy + dy * step)) break;
          far = step + 0.5;
        }
        return far;
      };
      if (!mine(cx, cy)) continue; // covered by something else; not this case's question
      const wide = reach(-1, 0) + reach(1, 0);
      const tall = reach(0, -1) + reach(0, 1);
      if (wide >= floor && tall >= floor) continue;
      const id =
        el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24) ?? el.tagName;
      out.push(`${id}: reaches ${wide}x${tall} (painted ${Math.round(box.width)}x${Math.round(box.height)})`);
    }
    return out;
  }, floor);
}

/**
 * Put a keyboard up.
 *
 * A phone keyboard does not resize the page: `window.innerHeight` is the same
 * 844 with it up and down, and `window.visualViewport` is the only thing that
 * says otherwise. So this says exactly what a phone says — a shorter visual
 * viewport and a `resize` on it — and anything that wants to know where the
 * keyboard is has to have asked the same place.
 */
async function keyboardUp(page: Page, takes: number): Promise<void> {
  await page.evaluate((takes) => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight - takes });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    Object.defineProperty(vv, 'pageTop', { configurable: true, get: () => 0 });
    vv.dispatchEvent(new Event('resize'));

    // A keyboard nobody can see is a picture nobody can read: the point of the
    // shot is where the menu is in relation to the glass the keyboard is on,
    // so the band is drawn. It takes no clicks and nothing measures it.
    const band = document.createElement('div');
    band.dataset.testid = 'the-keyboard';
    band.style.cssText =
      `position:fixed;left:0;right:0;bottom:0;height:${takes}px;z-index:2147483647;pointer-events:none;` +
      'background:repeating-linear-gradient(135deg,rgba(255,45,85,.28) 0 12px,rgba(255,45,85,.16) 12px 24px);' +
      'border-top:2px solid rgba(255,45,85,.9);font:600 13px system-ui,sans-serif;color:#fff;' +
      'display:flex;align-items:flex-start;justify-content:center;padding-top:6px;letter-spacing:.04em';
    band.textContent = `THE KEYBOARD — ${takes}px`;
    document.body.append(band);
  }, takes);
  await page.waitForTimeout(500);
}

test('a thumb reaches every control, and the @ menu stays out from under the keyboard', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-thumb');
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

  const project = await fixtureProject(request, 'thumb-and-at-menu', fixture);
  mkdirSync(SHOTS, { recursive: true });
  const small: string[] = [];

  try {
    // ---- The 44px floor, on the three screens the survey found it on.
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(1500);
    {
      const under = await tooSmall(page, TAP);
      note(`a chat at 390px: ${under.length ? under.join('; ') : `every control reaches ${TAP}px`}`);
      small.push(...under.map((u) => `a chat: ${u}`));
      await shoot(page, '01-chat-bar');
    }

    // The Git view, where [git-amend] is a 16px painted box.
    await page.getByTestId('chat-git-toggle').click();
    await expect(page.getByTestId('git-view')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(2500);
    {
      const under = await tooSmall(page, TAP);
      const amend = await page.getByTestId('git-amend').evaluate((el) => {
        const box = el.getBoundingClientRect();
        return `${Math.round(box.width)}x${Math.round(box.height)}`;
      });
      note(`the Git view at 390px: [git-amend] paints ${amend}; ${under.length ? under.join('; ') : `every control reaches ${TAP}px`}`);
      small.push(...under.map((u) => `the Git view: ${u}`));
      await shoot(page, '02-git-view');

      // The tick is measured by the row it shares with its own words, so the
      // words have to be what toggles it. Pressed at the far end of the line,
      // as far from the sixteen-pixel box as the row goes.
      const words = page.getByTestId('git-amend').locator('xpath=..');
      const wordsBox = (await words.boundingBox())!;
      const before = await page.getByTestId('git-amend').getAttribute('data-state');
      await page.mouse.click(wordsBox.x + wordsBox.width - 6, wordsBox.y + wordsBox.height / 2);
      await page.waitForTimeout(400);
      const after = await page.getByTestId('git-amend').getAttribute('data-state');
      note(`the amend row is ${Math.round(wordsBox.height)}px tall; pressed at its far end the tick went ${before} -> ${after}`);
      expect(after, 'the words beside the amend tick do not toggle it').not.toBe(before);
    }
    const close = page.getByTestId('chat-right-rail-close');
    if ((await close.count()) && (await close.isVisible())) await close.click();
    await page.waitForTimeout(700);

    // The Files tab, which has a toolbar of its own.
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await page.waitForTimeout(1500);
    {
      const under = await tooSmall(page, TAP);
      note(`the Files tab at 390px: ${under.length ? under.join('; ') : `every control reaches ${TAP}px`}`);
      small.push(...under.map((u) => `the Files tab: ${u}`));
      await shoot(page, '03-files-bar');
    }

    // ---- The @ menu with the keyboard up.
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(1500);

    const writing = page.getByTestId('composer-frame').locator('.cm-content');
    await writing.click();
    await keyboardUp(page, KEYBOARD);
    await page.keyboard.type('@src/l');
    await page.waitForTimeout(2500);

    const where = await page.evaluate(() => {
      const menu = document.querySelector('.cm-tooltip-autocomplete') as HTMLElement | null;
      const caret = document.querySelector('[data-testid="composer-frame"] .cm-cursor') as HTMLElement | null;
      const frame = document.querySelector('[data-testid="composer-frame"]') as HTMLElement | null;
      const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
      };
      return {
        menu: menu ? { ...box(menu)!, offscreen: menu.style.top === '-10000px' } : null,
        caret: box(caret),
        composer: box(frame),
        window: window.innerHeight,
        visible: Math.round(window.visualViewport!.height),
      };
    });
    const band = where.visible;
    note(
      `the @ menu with a ${KEYBOARD}px keyboard up: the window is still ${where.window}px and the visible band ends at y=${band}; ` +
        (where.menu
          ? `the menu is ${where.menu.height}px from y=${where.menu.top} to y=${where.menu.bottom}${where.menu.offscreen ? ' (PARKED OFFSCREEN)' : ''}`
          : 'NO menu was drawn') +
        `; the composer sits from y=${where.composer?.top ?? -1} to y=${where.composer?.bottom ?? -1}`,
    );
    await shoot(page, '04-at-menu-keyboard-up');

    expect(where.menu, 'no completion menu appeared for "@src/l"').not.toBeNull();
    expect(where.menu!.offscreen, 'the menu was parked offscreen rather than placed').toBe(false);
    expect(where.menu!.height, 'the menu has no room left to draw in').toBeGreaterThan(24);
    expect(where.menu!.bottom, `the menu's bottom is behind the keyboard (visible band ends at y=${band})`).toBeLessThanOrEqual(band);
    expect(where.menu!.top, 'the menu is drawn above the top of the screen').toBeGreaterThanOrEqual(0);
    // A menu you can see and a writing box you cannot is not an answer.
    expect(where.composer!.bottom, 'the composer itself is behind the keyboard').toBeLessThanOrEqual(band + 1);

    // A row of it is a target too, and the same floor applies with the menu up.
    const row = await page.evaluate(() => {
      const li = document.querySelector('.cm-tooltip-autocomplete > ul > li') as HTMLElement | null;
      return li ? Math.round(li.getBoundingClientRect().height) : -1;
    });
    note(`a row of the @ menu is ${row}px tall`);

    expect(small, `controls under ${TAP}px to a thumb`).toEqual([]);
  } finally {
    writeFileSync(`${SHOTS}/measurements.txt`, measured.map((m) => `- ${m}`).join('\n') + '\n');
    // eslint-disable-next-line no-console
    console.log(`\n${measured.map((m) => `- ${m}`).join('\n')}\n`);
    await request.delete(`/api/projects/${project.id}`).catch(() => {});
  }
});
