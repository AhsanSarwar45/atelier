import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * A chip stays a chip on a phone (bw-e3dw.16).
 *
 * The owner reported it off the running app — "badges are far too tall on
 * mobile" — and it is ours: bw-e3dw.6 raised the coarse-pointer floor to 44px
 * on `button`, on `a[href]` and on the `role=` list, and a chip that is
 * clickable is drawn as exactly those elements (`<Badge asChild><Button>` for a
 * card, `<Badge asChild><a href>` for a file or a site). So the same chip was
 * painted at two different heights depending only on whether it happened to be
 * clickable.
 *
 * This case asks the two questions the fix has to answer at once, of every chip
 * on the screen at 390px with touch:
 *
 *  * the painted pill — what the eye reads — must be the chip's own height,
 *    the same for a clickable chip as for one that is not;
 *  * the reachable area — what a thumb lands on — must still be large, and is
 *    measured the honest way, by probing outward from the chip's own centre
 *    with `elementFromPoint`, so an invisible target answers in its owner's
 *    name (the same probe as a-thumb-and-the-at-menu.spec.ts).
 *
 * And the third question that comes with the second: two chips side by side
 * must not steal each other's presses. Each chip is pressed at its own centre
 * and the app is asked which one it thinks was pressed.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-chip-stays-a-chip.spec.ts
 */

const STAGE = process.env.CHIP_STAGE ?? 'now';
const SHOTS = `tests/results/a-chip-stays-a-chip/${STAGE}`;
const WAIT = 60_000;
const CHAT = 'a-chip-stays-a-chip';
/** Two cards for the rail to draw as chips. The board need not have them. */
const CARDS = ['wl-chip1', 'wl-chip2'];

const PHONE = { width: 390, height: 844 };
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
  git(where, 'config', 'user.name', 'A Chip');
  git(where, 'config', 'user.email', 'chip@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');
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

interface Chip {
  what: string;
  tag: string;
  clickable: boolean;
  tappable: boolean;
  paintedW: number;
  paintedH: number;
  reachW: number;
  reachH: number;
  /** What answered where the target stopped growing upward and downward. */
  stoppedBy: string[];
  /** Whether the chip is a word inside a body of prose, where a line above and
   *  a line below belong to somebody else (WCAG 2.2 §2.5.8's inline exception). */
  inASentence: boolean;
}

/**
 * Every chip on the screen, painted and reached.
 *
 * The painted pill is `getBoundingClientRect`, which is what the eye reads.
 * The reach is probed outward from the chip's own centre, out to the floor and
 * no further, exactly as the thumb case does — so a chip that keeps a small
 * painted box and grows an invisible target answers honestly, and a chip that
 * simply became a 44px pill cannot pass by pretending to be one.
 */
async function chips(page: Page, floor: number): Promise<Chip[]> {
  return page.evaluate((floor) => {
    const out: Chip[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-slot="badge"]'))) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const mine = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
        const on = document.elementFromPoint(x, y);
        return on !== null && el.contains(on);
      };
      // Who answered instead, said in a word: another chip, some other target,
      // or the page. A target that stops because a NEIGHBOUR is there has
      // grown as far as the line allows, which is the inline exception; one
      // that stops on the page has simply failed to grow.
      const whoever = (x: number, y: number): string => {
        const on = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!on) return 'off the screen';
        if (on.closest('[data-slot="badge"]')) return 'another chip';
        if (on.closest('button, a[href], [role="button"], input, textarea, select')) return 'another target';
        return `the page (${on.tagName.toLowerCase()})`;
      };
      const stopped: string[] = [];
      const reach = (dx: number, dy: number, name?: string) => {
        let far = 0;
        for (let step = 0.5; step <= floor; step += 1) {
          if (!mine(cx + dx * step, cy + dy * step)) {
            if (name) stopped.push(`${name}: ${whoever(cx + dx * step, cy + dy * step)}`);
            break;
          }
          far = step + 0.5;
        }
        return far;
      };
      if (!mine(cx, cy)) continue; // something else is drawn over it; not this question
      const what =
        el.getAttribute('data-testid') ??
        el.getAttribute('data-reference') ??
        el.textContent?.trim().slice(0, 20) ??
        el.tagName;
      out.push({
        what,
        tag: el.tagName.toLowerCase(),
        // Two different questions, so two different marks. `clickable` is
        // whether the chip is one of the ELEMENTS the coarse floor names, which
        // is what decided its painted height. `tappable` is whether a finger is
        // meant to hit it at all, which a file chip is by its own mark even
        // though it is a plain span.
        clickable: el.matches('button, a[href], [role="button"]'),
        tappable: el.matches('button, a[href], [role="button"], [data-path-mention]'),
        paintedW: Math.round(box.width),
        paintedH: Math.round(box.height),
        reachW: reach(-1, 0) + reach(1, 0),
        reachH: reach(0, -1, 'up') + reach(0, 1, 'down'),
        stoppedBy: stopped,
        inASentence: el.closest('.prose') !== null,
      });
    }
    return out;
  }, floor);
}

/**
 * Chips that answer for a neighbour instead of for themselves.
 *
 * Each chip is asked what the app thinks was pressed at its own middle, and
 * the answer has to be itself. Read inside one part of the screen at a time
 * and not across the whole page: the rail is a sheet on a phone and lies over
 * the transcript, so a transcript chip UNDER it is answered by whatever the
 * sheet draws there — which is the sheet doing its job, not a chip stealing.
 */
async function stealing(page: Page, within: string): Promise<string[]> {
  return page.evaluate((within) => {
    const out: string[] = [];
    const root = document.querySelector(within);
    if (!root) return [`nothing at ${within} to read`];
    for (const el of Array.from(root.querySelectorAll('[data-slot="badge"]')) as HTMLElement[]) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const on = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (on === null || el.contains(on)) continue;
      if (!root.contains(on)) continue; // something over this part of the screen, not a neighbour
      const thief = (on as HTMLElement).closest('[data-slot="badge"]');
      if (thief && thief !== el) {
        out.push(`${el.textContent?.trim().slice(0, 16)} was answered by ${thief.textContent?.trim().slice(0, 16)}`);
      }
    }
    return out;
  }, within);
}

function say(chip: Chip): string {
  return (
    `${chip.what} <${chip.tag}${chip.clickable ? ' clickable' : chip.tappable ? ' tappable' : ''}> ` +
    `painted ${chip.paintedW}x${chip.paintedH}, reaches ${chip.reachW}x${chip.reachH}` +
    (chip.inASentence ? ' [in a sentence]' : '') +
    (chip.stoppedBy.length ? ` (stopped ${chip.stoppedBy.join(', ')})` : '')
  );
}

test('a chip keeps its own height on a phone and still answers a thumb', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-chip');
  seed(fixture);

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  // One message carrying every kind of chip the app draws: a file named in
  // prose (a span), a markdown link to a file and to a site (both `a[href]`),
  // and a card mentioned by id (a `button`). The point of the case is that all
  // of them are the same height.
  const said =
    'Read src/main.ts and then src/lib/deep.ts.\n\n' +
    `A link to [the deep one](${join(fixture, 'src', 'lib', 'later.ts')}) and one to [the docs](https://example.com/docs).\n`;
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: fixture, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: said },
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
        // Two cards, so the rail draws the OTHER clickable chip the app has:
        // `<Badge asChild><Button>`, a chip that is a real `button` element.
        beads: CARDS,
      },
    }),
  );

  const project = await fixtureProject(request, 'a-chip-stays-a-chip', fixture);
  mkdirSync(SHOTS, { recursive: true });

  try {
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(2000);

    // The composer's file-reference badges are the ones the owner is looking
    // at, so they are on screen for the same reading.
    const writing = page.getByTestId('composer-frame').locator('.cm-content');
    await writing.click();
    await page.keyboard.type('@src/main.ts and @src/lib/deep.ts ');
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const inTheChat = await chips(page, TAP);
    note('the chat:');
    for (const chip of inTheChat) note(`  ${say(chip)}`);
    await shoot(page, '01-a-chat-of-chips');
    const stolen = await stealing(page, '[data-testid="transcript"]');

    // The rail is a sheet on a phone and lies over the chat, so it is read
    // separately rather than through it: a card there is drawn as the app's
    // OTHER clickable chip, `<Badge asChild><Button>`, a real `button`.
    const rail = page.getByTestId('chat-right-rail');
    if ((await rail.getAttribute('data-open')) !== 'true') await page.getByTestId('chat-right-rail-toggle').click();
    await expect(page.getByTestId('rail-cards')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(800);
    const inTheRail = await chips(page, TAP);
    note('the rail:');
    for (const chip of inTheRail) note(`  ${say(chip)}`);
    await shoot(page, '02-the-rail-of-chips');
    stolen.push(...(await stealing(page, '[data-testid="chat-right-rail"]')));

    const seen = [...inTheChat, ...inTheRail];

    // ---- The question the owner asked. A chip is one height, whatever it is
    // made of. The chips that are not clickable are the app's own answer for
    // how tall a chip is, so they are the figure the clickable ones are held
    // to rather than a number written down here.
    const plain = seen.filter((c) => !c.clickable);
    const clickable = seen.filter((c) => c.clickable);
    expect(plain.length, 'no plain chip on screen to compare against').toBeGreaterThan(0);
    expect(clickable.length, 'no clickable chip on screen to test').toBeGreaterThan(0);
    const tallestPlain = Math.max(...plain.map((c) => c.paintedH));
    note(`the tallest chip that is not clickable paints ${tallestPlain}px`);
    for (const chip of clickable) {
      // To within a pixel: `sm` is `h-5`, and where a chip's line box lands on
      // the device grid decides whether that measures back as 19 or 20. The
      // fault this is watching for was 44 against 19, not a pixel of rounding.
      expect(chip.paintedH, `a clickable chip is taller than a chip: ${say(chip)}`).toBeLessThanOrEqual(tallestPlain + 1);
    }

    // ---- And it is still reachable. A chip is small on purpose, so the floor
    // it answers is the reachable area and not the painted one — and the
    // question is asked of every chip a finger is meant to hit, including the
    // file chip, which is a span the conversation's own listener opens.
    // Forty-four wherever the chip is laid out as a control, with room around
    // it. A chip that is a WORD inside a paragraph is the inline exception WCAG
    // 2.2 §2.5.8 makes for exactly this case — the line above it and the line
    // below it are somebody else's — and it answers for its own pill and no
    // more, which is also all the app can give it without one chip taking the
    // press meant for the one beneath it.
    const tappable = seen.filter((c) => c.tappable);
    for (const chip of tappable) {
      if (chip.inASentence) {
        expect(chip.reachH, `a chip does not answer over its own pill: ${say(chip)}`).toBeGreaterThanOrEqual(chip.paintedH);
        continue;
      }
      expect(chip.reachH, `a chip with room around it a thumb cannot land on: ${say(chip)}`).toBeGreaterThanOrEqual(TAP);
    }
    const roomy = tappable.filter((c) => !c.inASentence);
    note(
      `${tappable.length} chips a thumb is meant to hit: ${roomy.length} laid out as controls, ` +
        `all reaching ${TAP}px; ${tappable.length - roomy.length} written into a sentence, each answering for its own pill`,
    );

    // ---- Neighbours. Every chip was pressed at its own centre as each part of
    // the screen was read; each one has to have answered for itself.
    note(stolen.length ? `presses stolen between neighbours: ${stolen.join('; ')}` : 'no chip answers for its neighbour');
    expect(stolen, 'a chip is answering for its neighbour').toEqual([]);
  } finally {
    writeFileSync(`${SHOTS}/measurements.txt`, measured.map((m) => `- ${m}`).join('\n') + '\n');
    // eslint-disable-next-line no-console
    console.log(`\n${measured.map((m) => `- ${m}`).join('\n')}\n`);
    await request.delete(`/api/projects/${project.id}`).catch(() => {});
  }
});
