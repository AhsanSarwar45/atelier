import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { bd } from './fixture-board';
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The epic's own proof (bw-e3dw.7).
 *
 * bw-e3dw.1 went and LOOKED: the-app-on-a-phone-survey.spec.ts walks every
 * screen at 390x844 and writes down what it measures, and is deliberately not
 * red on what it finds. This case is the other half — the same walk, judged.
 * The epic's acceptance is one sentence, "every screen is usable at a 390px
 * viewport, with no horizontal scrolling and no control out of reach", so every
 * screen the app has is driven here with touch and asked exactly that, and a
 * picture is kept of each.
 *
 * It does not restate the nine cases under the epic. Each of those proves one
 * card in depth — that the diff breaks no word (the-git-diff-on-a-phone), that
 * a chip keeps its painted height (a-chip-stays-a-chip), that the zoom floor is
 * derived (a-picture-of-any-size-fits-the-view). What this one owns is the
 * property that belongs to no single card: that the whole app, screen by
 * screen, fits the hand it is held in.
 *
 * Two lists sit at the top of this file and they mean opposite things. EXEMPT
 * is what the survey found to be the design and not a fault — the board's
 * sideways swipe, a fenced code block, a picture at its own pixel size — each
 * written by name with its reason and each proved to still be what it claims.
 * KNOWN is what this walk found to be a real fault and could not fix here, with
 * the card it was filed under. Neither is a loosened assertion: anything not on
 * one of the two lists turns this case red.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-app-on-a-phone.spec.ts
 */

const STAGE = process.env.PHONE_APP_STAGE ?? 'now';
const SHOTS = `tests/results/the-app-on-a-phone/${STAGE}`;
const MEDIA = join(__dirname, '..', 'fixtures', 'files-preview');
const WAIT = 60_000;
const CHAT = 'the-app-on-a-phone-chat';

/** A modern phone in the hand, as Playwright's own iPhone 14 preset has it. */
const PHONE = { width: 390, height: 844 };

/** The long-standing floor for a target a thumb has to hit. */
const THUMB = 44;

/** What a phone keyboard takes off the bottom of a 844px screen. */
const KEYBOARD = 336;

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

/**
 * The exemptions: what is allowed to run past the right edge, and why.
 *
 * The survey found three places where sideways movement is the design and not
 * a fault. They are written here by name with the reason, rather than by
 * loosening the assertion — a weaker rule would also excuse the next real
 * fault, and nobody reading it would know which of the two it was for. Each is
 * additionally PROVED to still be what it claims to be, on the screen it
 * belongs to, by the steps below: an exemption nobody checks is a hole.
 */
const EXEMPT: { what: string; because: string }[] = [
  {
    what: 'board-scroll',
    because:
      'the board is a stack of full-width columns a thumb swipes between: snap-x snap-mandatory with --column-min set to the window, so one column at a time is the whole point (kanban-board.tsx)',
  },
  {
    what: 'column-tabs',
    because:
      'the row of column names pages sideways with the columns it names, and every name can be brought into view by the same swipe',
  },
  {
    what: 'open-files-strip',
    because:
      'the kept files scroll under a thumb inside their own strip, which is how a tab strip works on a phone and does not move the page (bw-e3dw.5)',
  },
  {
    what: 'file-preview-image-stage',
    because:
      'a picture opens at its real pixel size and may be larger than the phone: the stage clips it and the zoom moves it, so the picture never moves the page (bw-e3dw.17)',
  },
  {
    what: 'pre',
    because:
      'a fenced code block in Markdown keeps a line of code on one line on purpose and carries its own sideways scroll, the way every Markdown reader draws one',
  },
];

/**
 * What this walk really did find, already filed, and not this case's to fix.
 *
 * This is the opposite of the list above and must never be confused with it.
 * An exemption says "this is not a fault"; an entry here would say "this IS a
 * fault, it is filed as such, and until that card is done this case knows
 * about exactly these and no others". It is a ratchet, not a pardon: anything
 * new turns the case red, and an entry that STOPS appearing turns it red too,
 * so the card that fixes one comes here and deletes its line rather than
 * leaving a note about a fault nobody has.
 *
 * It is empty, and empty is the healthy state. It held two rows this walk
 * found — the name of a chat in the restore list at 32px and the diff's file
 * disclosure at 36px — which were filed as bw-e3dw.18; that card gave every
 * row of that kind a reach band and deleted both lines from here.
 */
const KNOWN: { screen: string; control: string; card: string; why: string }[] = [];
const knownSeen = new Set<string>();

/** Chips written into a sentence answer to a different rule than controls do. */
const ROWS_DIVIDE =
  "WCAG 2.2 2.5.8's spacing rule: what stopped this row short is the next row's own reach, or the edge of the list it is in — so the space is divided, every pixel of it belongs to somebody, and this row could only grow by answering for its neighbour or for the bar past the end of the pane";

const INLINE_CHIPS =
  "WCAG 2.2 2.5.8's inline exception: a chip laid into a line of prose takes its size from the line, and a-chip-stays-a-chip.spec.ts owns that measurement";

interface Fault {
  screen: string;
  what: string;
}
const faults: Fault[] = [];
const measured: string[] = [];
const shots: string[] = [];

function note(what: string): void {
  measured.push(what);
}

function fault(screen: string, what: string): void {
  const known = KNOWN.find((one) => one.screen === screen && what.includes(one.control));
  if (known) {
    knownSeen.add(`${known.screen}/${known.control}`);
    measured.push(`   ~~ ${what} — known, filed as ${known.card}`);
    return;
  }
  faults.push({ screen, what });
  measured.push(`   !! ${what}`);
}

function git(at: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: at,
    stdio: 'pipe',
  });
}

const DEEP = `${Array.from({ length: 40 }, (_, at) => `const aRatherLongIdentifierOnLine${at + 1} = ${at + 1};`).join('\n')}\n`;

const MARKDOWN = `# The project, read on a phone

A paragraph long enough to need wrapping when the screen is only three hundred
and ninety pixels wide, which is the whole question this case asks. It mentions
src/main.ts so the prose has a chip laid into it.

| Column one | Column two | Column three | Column four |
| --- | --- | --- | --- |
| a value | another value | a third value | a fourth value |

\`\`\`ts
const aLineOfCodeThatIsFarTooLongToFitOnAPhoneScreenAndMustNotBeFoldedInHalf = somethingElse(withAnArgument, andAnother, andAThirdOneAsWell, soThatTheLineIsWellPastAnyWidthAPhoneCouldOffer);
\`\`\`
`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500" viewBox="0 0 900 500">
  <rect x="10" y="10" width="880" height="480" rx="24" fill="#519aba" />
  <circle cx="450" cy="250" r="180" fill="#e37933" />
</svg>
`;

const BEFORE = `export const main = 1;
const kept = 'a line that neither side changed';
const alsoKept = 'another line that neither side changed';
export const goingAway = 'this line is deleted by the change';
`;

const AFTER = `export const main = 2;
const kept = 'a line that neither side changed';
const alsoKept = 'another line that neither side changed';
export const arrivedWithTheChange = 'a rather long added line so the diff has something wide to draw';
`;

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src', 'lib'), { recursive: true });
  mkdirSync(join(where, 'assets'), { recursive: true });
  writeFileSync(join(where, 'README.md'), MARKDOWN);
  writeFileSync(join(where, 'src', 'main.ts'), BEFORE);
  writeFileSync(join(where, 'src', 'lib', 'deep.ts'), DEEP);
  writeFileSync(join(where, 'assets', 'drawing.svg'), SVG);
  copyFileSync(join(MEDIA, 'shot.png'), join(where, 'assets', 'shot.png'));
  copyFileSync(join(MEDIA, 'clip.mp4'), join(where, 'assets', 'clip.mp4'));

  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'The App On A Phone');
  git(where, 'config', 'user.email', 'the-app-on-a-phone@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');

  // Something for the Git view and the diff to have to say.
  writeFileSync(join(where, 'src', 'main.ts'), AFTER);
  writeFileSync(join(where, 'scratch.txt'), 'a file git has never been told about\n');

  // A board of its own, so the Board tab has columns to draw rather than the
  // empty case: the app only believes a project keeps cards when its manifest
  // says so, and only draws them when a database is really there.
  bd(['init', '--prefix', 'ph'], where);
  mkdirSync(join(where, '.atelier'), { recursive: true });
  writeFileSync(
    join(where, '.atelier', 'project.toml'),
    [
      'schema_version = 1',
      '',
      '[project]',
      'display_name = "the-app-on-a-phone"',
      'use_beads = true',
      'summary = ""',
      '',
      '[git]',
      'completed_work_branch = "main"',
      '',
      '[beads]',
      'issue_id_prefix = "ph"',
      '',
    ].join('\n'),
  );
  const cards = [
    { id: 'ph-1', title: 'A card with a title long enough to need wrapping in a column', status: 'open', issue_type: 'epic', priority: 1 },
    { id: 'ph-2', title: 'Something under way', status: 'in_progress', issue_type: 'task', priority: 1 },
    { id: 'ph-3', title: 'Something finished', status: 'closed', issue_type: 'task', priority: 2 },
    { id: 'ph-4', title: 'Something still waiting', status: 'open', issue_type: 'task', priority: 2 },
  ];
  writeFileSync(join(where, 'seed.jsonl'), cards.map((one) => JSON.stringify(one)).join('\n') + '\n');
  bd(['import', '--input', 'seed.jsonl'], where);
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
  const path = `${SHOTS}/${name}.png`;
  await page.screenshot({ path, animations: 'disabled' });
  shots.push(path);
}

interface Wide {
  document: number;
  body: number;
  window: number;
  over: { what: string; width: number; right: number; exempt: string | null }[];
  scrollers: { what: string; scroll: number; shown: number; exempt: string | null }[];
  cutOff: { what: string; where: string; exempt: string | null }[];
}

/**
 * Does anything on this screen push the page sideways, or hold more than it
 * shows without being one of the named exemptions?
 */
async function wideness(page: Page, exempt: { what: string; because: string }[]): Promise<Wide> {
  return page.evaluate((allowed) => {
    const window_ = document.documentElement.clientWidth;

    /** Which exemption, if any, covers this element. */
    const excused = (el: HTMLElement): string | null => {
      for (const one of allowed) {
        const selector =
          one.what === 'pre' ? 'pre' : `[data-testid="${one.what}"]`;
        if (el.matches(selector) || el.closest(selector)) return one.what;
      }
      return null;
    };

    /**
     * Is this element only wide because something above it clips or scrolls?
     * A pane drawn shut with a transform, or one that pages under a thumb,
     * holds children far to the right on purpose; what widens the PAGE is the
     * outermost box that is not held by anything.
     */
    const held = (el: HTMLElement): boolean => {
      for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.overflowX !== 'visible' || style.overflow !== 'visible') return true;
      }
      return false;
    };

    const name = (el: HTMLElement) => {
      const id = el.getAttribute('data-testid');
      if (id) return `[${id}]`;
      const classes = String(el.className || '').split(' ').slice(0, 3).join('.');
      return `${el.tagName.toLowerCase()}.${classes}`;
    };

      const cutOff: { what: string; where: string; exempt: string | null }[] = [];
    const pressable = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], input, select, summary';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(pressable))) {
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
      // A sheet drawn shut holds its controls off the edge of the window on
      // purpose; they are not this screen's controls until it is opened.
      const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      if (middle.x < 0 || middle.x > window.innerWidth) continue;
      if (middle.y < 0 || middle.y > window.innerHeight) continue;
      // The nearest box that cuts things off. A box that SCROLLS is not one:
      // whatever it holds is a swipe away, which is how a tab strip works.
      let clipper: HTMLElement | null = null;
      for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.overflowX === 'hidden' || style.overflowY === 'hidden') { clipper = up; break; }
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') break;
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') break;
      }
      if (!clipper) continue;
      const room = clipper.getBoundingClientRect();
      if (box.left >= room.left - 1 && box.right <= room.right + 1) continue;
      cutOff.push({
        what: name(el),
        where: `${Math.round(box.left)}..${Math.round(box.right)} in a box from ${Math.round(room.left)} to ${Math.round(room.right)}`,
        exempt: excused(el) ?? excused(clipper),
      });
    }

    const over: { what: string; width: number; right: number; exempt: string | null }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const box = el.getBoundingClientRect();
      if (box.width < 4 || box.height === 0) continue;
      if (box.right <= window_ + 1) continue;
      if (el.parentElement && el.parentElement.getBoundingClientRect().right > window_ + 1) continue;
      if (held(el)) continue;
      over.push({ what: name(el), width: Math.round(box.width), right: Math.round(box.right), exempt: excused(el) });
    }

    // A pane the reader has to SWIPE to finish reading. A box that merely
    // clips — a name with an ellipsis, a path cut off at the end of its line —
    // is not one of these: it holds more than it shows on purpose and the
    // reader loses nothing they can act on. What the epic is looking for is a
    // screen that has been PUT sideways, so only a box that really scrolls is
    // counted, and what a clipping box hides is asked about separately below.
    const scrollers: { what: string; scroll: number; shown: number; exempt: string | null }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid], pre'))) {
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      // A pane a few pixels narrower than its content is a rounding artefact,
      // and a one-pixel box is the composer's hidden mirror, not a screen.
      if (el.clientWidth < 24 || el.scrollWidth - el.clientWidth < 8) continue;
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX !== 'auto' && overflowX !== 'scroll') continue;
      scrollers.push({
        what: name(el),
        scroll: el.scrollWidth,
        shown: el.clientWidth,
        exempt: excused(el),
      });
    }

    return {
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      window: window_,
      over: over.slice(0, 10),
      scrollers: scrollers.slice(0, 10),
      cutOff: cutOff.slice(0, 10),
    };
  }, exempt);
}

interface Short {
  what: string;
  reach: string;
  painted: string;
  exempt: string | null;
}

/**
 * Which controls on this screen a thumb cannot hit.
 *
 * Measured as the area that actually ANSWERS a press, not the painted box: the
 * amend row is the target rather than its 16px tick, and a chip grows an
 * invisible reach band rather than getting taller (bw-e3dw.6, .16). Only what
 * is on the screen is judged — a control scrolled out of a pane, or a sheet
 * drawn shut off the edge, is not a control this screen is showing.
 */
async function outOfReach(page: Page, floor: number, inlineChips: string, rowsDivide: string): Promise<Short[]> {
  return page.evaluate(
    ({ floor: want, inlineChips: prose, rowsDivide: divided }) => {
      const pickable =
        'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], input[type="checkbox"], input[type="radio"], summary';
      const seen: { what: string; reach: string; painted: string; exempt: string | null }[] = [];
      const already = new Set<string>();

      for (const el of Array.from(document.querySelectorAll<HTMLElement>(pickable))) {
        const box = el.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
        if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') continue;
        if (el.closest('[aria-hidden="true"]')) continue;
        // The outermost control is the target; a tick inside a pressable row is
        // not a second one.
        if (el.parentElement?.closest(pickable)) continue;
        // Off this screen: scrolled out of a pane, or a sheet drawn shut.
        const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        if (middle.x < 0 || middle.y < 0 || middle.x > window.innerWidth || middle.y > window.innerHeight) continue;

        const label = el.closest('label');
        const landsOn = (x: number, y: number): Element | null => {
          if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
          return document.elementFromPoint(x, y);
        };
        const answers = (x: number, y: number): boolean => {
          const on = landsOn(x, y);
          if (!on) return false;
          if (on === el || el.contains(on) || on.contains(el)) return true;
          return Boolean(label && label.contains(on));
        };
        if (!answers(middle.x, middle.y)) continue;

        // Probed at the half pixel, so what comes back is a width and not a
        // count of points: a box forty-four across is hit at 0.5 through 43.5
        // from its own centre and reads back as forty-four. The same
        // arithmetic as a-thumb-and-the-at-menu.spec.ts, which owns the
        // measurement itself; here it is asked of every screen.
        const reach = (dx: number, dy: number): { far: number; stoppedBy: Element | null } => {
          let far = 0;
          for (let step = 0.5; step <= want; step += 1) {
            if (!answers(middle.x + dx * step, middle.y + dy * step)) {
              return { far, stoppedBy: landsOn(middle.x + dx * step, middle.y + dy * step) };
            }
            far = step + 0.5;
          }
          return { far, stoppedBy: null };
        };
        const ways = { left: reach(-1, 0), right: reach(1, 0), up: reach(0, -1), down: reach(0, 1) };
        const wide = ways.left.far + ways.right.far;
        const tall = ways.up.far + ways.down.far;
        if (wide >= want && tall >= want) continue;

        const what =
          el.getAttribute('data-testid') ||
          el.getAttribute('aria-label') ||
          (el.textContent ?? '').trim().slice(0, 28) ||
          el.tagName.toLowerCase();
        if (already.has(what)) continue;
        already.add(what);

        const inASentence =
          Boolean(el.closest('.prose')) &&
          Boolean(el.closest('[data-slot="badge"], [data-path-mention], [data-reference]'));
        // A row in a list can only be as big as its neighbours leave it. Where
        // the thing that stopped it short is the NEXT ROW's own reach, the two
        // have divided the space between them: every pixel belongs to one of
        // them, and this one could only grow by answering for the other, which
        // is the one thing a bigger target must not buy. Asked way by way, so
        // a row hemmed in on one side and simply small on the other is still a
        // fault, and never below 24px, which is the floor no arrangement of
        // neighbours excuses.
        // The list this row is in, if it is in one: a row at the top or the
        // bottom of a pane reaches as far as the pane does and no further,
        // because what is past its edge is the bar above or the composer
        // below, and a press there belongs to them.
        let pane: HTMLElement | null = el.parentElement;
        while (pane && pane !== document.body) {
          const how = getComputedStyle(pane);
          if (how.overflowY === 'auto' || how.overflowY === 'scroll') break;
          pane = pane.parentElement;
        }
        const held = (way: { stoppedBy: Element | null }): boolean => {
          const on = way.stoppedBy;
          if (!on || el.contains(on)) return false;
          if (on.closest('[data-reach="row"]')) return true;
          return Boolean(pane && pane !== document.body && !pane.contains(on));
        };
        const short = Object.values(ways).filter((way) => way.far < want / 2);
        const heldByItsNeighbours =
          el.matches('[data-reach="row"]') && short.length > 0 && short.every(held) && wide >= 24 && tall >= 24;

        seen.push({
          what,
          reach: `${wide}x${tall}`,
          painted: `${Math.round(box.width)}x${Math.round(box.height)}`,
          exempt: inASentence ? prose : heldByItsNeighbours ? divided : null,
        });
      }
      return seen;
    },
    { floor, inlineChips, rowsDivide },
  );
}

/** Everything this epic promises about one screen, asked at once. */
async function judge(page: Page, screen: string, shot: string): Promise<Wide> {
  const wide = await wideness(page, EXEMPT);
  note(`-- ${screen}`);
  note(`   the document is ${wide.document}px in a ${wide.window}px window (body ${wide.body}px)`);

  if (wide.document > wide.window + 1 || wide.body > wide.window + 1) {
    fault(screen, `THE PAGE SCROLLS SIDEWAYS: the document is ${wide.document}px (body ${wide.body}px) in a ${wide.window}px window`);
  }
  for (const one of wide.over) {
    if (one.exempt) {
      note(`   past the edge, and allowed to be: ${one.what} (${one.exempt})`);
      continue;
    }
    fault(screen, `runs off the right edge: ${one.what} is ${one.width}px wide and ends at x=${one.right}`);
  }
  for (const one of wide.scrollers) {
    if (one.exempt) {
      note(`   scrolls inside itself, and is meant to: ${one.what} holds ${one.scroll}px in ${one.shown}px (${one.exempt})`);
      continue;
    }
    fault(screen, `has to be swiped sideways to be read: ${one.what} holds ${one.scroll}px in ${one.shown}px`);
  }
  for (const one of wide.cutOff) {
    if (one.exempt) {
      note(`   cut off by the box around it, and allowed to be: ${one.what} (${one.exempt})`);
      continue;
    }
    fault(screen, `a control is cut off by the box around it: ${one.what} sits at ${one.where}`);
  }

  for (const one of await outOfReach(page, THUMB, INLINE_CHIPS, ROWS_DIVIDE)) {
    if (one.exempt) {
      note(`   smaller than a thumb, and allowed to be: ${one.what} reaches ${one.reach} (${one.exempt})`);
      continue;
    }
    fault(screen, `out of reach of a thumb: ${one.what} reaches ${one.reach} (painted ${one.painted}), under ${THUMB}px`);
  }

  await rowsAnswerForThemselves(page, screen);
  await shoot(page, shot);
  return wide;
}

/** The Files tab's tree, put into the state this step needs, however it began. */
async function tree(page: Page, want: 'open' | 'shut'): Promise<void> {
  const rail = page.getByTestId('files-rail');
  if ((await rail.getAttribute('data-open')) !== String(want === 'open')) {
    await page.getByTestId('files-rail-toggle').click();
  }
  await expect(rail).toHaveAttribute('data-open', String(want === 'open'), { timeout: WAIT });
  await page.waitForTimeout(800);
}

/**
 * Every row that was given a reach band answers for its own middle.
 *
 * A target grown bigger is worth nothing if it grew over its neighbour: the
 * press that used to open the row below now opens this one, and the reader
 * has no way of knowing why. So each marked row is asked what a press at the
 * exact centre of its own painted box would land on (bw-e3dw.18).
 */
async function rowsAnswerForThemselves(page: Page, screen: string): Promise<void> {
  const stolen = await page.evaluate(() => {
    const wrong: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-reach="row"]'))) {
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      if (middle.x < 0 || middle.x > window.innerWidth) continue;
      if (middle.y < 0 || middle.y > window.innerHeight) continue;
      const on = document.elementFromPoint(middle.x, middle.y);
      if (on && (on === el || el.contains(on) || on.contains(el))) continue;
      // Only another ROW counts as theft. A sheet or a menu drawn over the
      // whole pane also stops a press reaching what is under it, and is
      // supposed to: that is what the scrim is for, and the screens that open
      // one prove separately that the bar behind stays pressable.
      const who = (on as HTMLElement | null)?.closest('[data-reach="row"]');
      if (!who || who === el) continue;
      // ...and only a row it shares a list with. A menu or a sheet is drawn
      // through a portal, so a row inside one and a row in the transcript
      // underneath it first meet at <body> or at the portal's own wrapper
      // beneath it; two rows of one list meet far deeper than that. So the
      // accusation only stands when the two share an ancestor that is not the
      // page itself.
      let together: HTMLElement | null = el.parentElement;
      while (together && !together.contains(who)) together = together.parentElement;
      if (!together || together === document.body || together.parentElement === document.body) continue;
      wrong.push(
        `${el.getAttribute('data-testid') ?? (el.textContent ?? '').trim().slice(0, 24)} is answered for by another row (${who.getAttribute('data-testid') ?? 'unnamed'})`,
      );
    }
    return wrong;
  });
  for (const one of stolen) fault(screen, `a row does not answer for its own middle: ${one}`);
}

/** Is the control at this id the thing a press at its own middle would hit? */
async function pressable(page: Page, id: string): Promise<boolean> {
  const control = page.getByTestId(id);
  if ((await control.count()) === 0) return false;
  return control.first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    const on = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(on && (on === el || el.contains(on) || on.contains(el)));
  });
}

/** A keyboard, as the browser reports one: the visual viewport shrinks. */
async function keyboardUp(page: Page, takes: number): Promise<void> {
  await page.evaluate((height) => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const short = window.innerHeight - height;
    Object.defineProperty(viewport, 'height', { value: short, configurable: true });
    Object.defineProperty(viewport, 'offsetTop', { value: 0, configurable: true });
    viewport.dispatchEvent(new Event('resize'));
  }, takes);
  await page.waitForTimeout(600);
}

test('every screen at a phone width, judged', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-the-app-on-a-phone');
  seed(fixture);

  const deep = join(fixture, 'src', 'lib', 'deep.ts');
  const said = `Look at ${deep}:7 — and at src/main.ts, which I changed.`;
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  // A thought and a tool call as well as an answer: the rows a reader opens
  // most are the transcript's own disclosure lines, and a transcript of one
  // paragraph would walk past all of them (bw-e3dw.18).
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: fixture, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'thinking.delta', messageId: 'thought', text: 'Reading the file the reader asked about, and then the change beside it.' },
    { ...base, seq: 3, type: 'message.completed', messageId: 'thought' },
    { ...base, seq: 4, type: 'tool.started', toolCallId: 'ran', name: 'Bash', input: { command: `sed -n 7p ${deep}` }, title: `Read a file in ${fixture}`, parentToolCallId: null },
    { ...base, seq: 5, type: 'tool.completed', toolCallId: 'ran', ok: true, output: 'const aRatherLongIdentifierOnLine7 = 7;' },
    { ...base, seq: 6, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 7, type: 'text.delta', messageId: 'answer', text: said },
    { ...base, seq: 8, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 9, type: 'session.state', state: 'idle', label: 'Ready' },
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: [
        {
          sessionId: CHAT,
          externalId: 'fixture',
          brand: 'claude',
          title: 'A chat read on a phone',
          state: 'idle',
          lastActiveAt: new Date(0).toISOString(),
          cwdHint: fixture,
          runningElsewhere: false,
          held: null,
          beads: [],
        },
      ],
    }),
  );
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

  const project = await fixtureProject(request, 'the-app-on-a-phone', fixture);
  mkdirSync(SHOTS, { recursive: true });

  const named = (path: string) =>
    page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/${path}"]`);

  try {
    // ---- 1. The project list, which is the way in. -----------------------
    await page.goto('/');
    await page.getByTestId('shell').waitFor({ timeout: WAIT });
    await page.waitForTimeout(1500);
    await judge(page, 'the project list', '01-project-list');

    // ---- 2. The board, and the swipe it is built around. -----------------
    await page.goto(`/project?id=${project.id}&tab=board`);
    await page.getByTestId('board-scroll').waitFor({ timeout: WAIT });
    await page.waitForTimeout(3000);
    await judge(page, 'the board', '02-board');

    // The exemption above says the board pages sideways on purpose. Prove it
    // is still that, and not a board that has simply become too wide: one
    // column to a screen, snapped, and the next one a swipe away.
    const strip = await page.getByTestId('board-scroll').evaluate((el) => {
      const first = el.querySelector('[data-testid="column-scroll"]')?.parentElement as HTMLElement | null;
      return {
        snap: getComputedStyle(el).scrollSnapType,
        shown: el.clientWidth,
        column: first ? Math.round(first.getBoundingClientRect().width) : -1,
      };
    });
    note(`   the board's strip snaps "${strip.snap}" and a column is ${strip.column}px of the ${strip.shown}px it shows`);
    expect(strip.snap, 'the board strip must snap, one column to a swipe').toContain('mandatory');
    expect(strip.column, 'a column on a phone is the width of the screen it is read on').toBeGreaterThan(strip.shown * 0.8);

    // And the row of column names reaches its last name by the same swipe.
    const namesReach = await page.getByTestId('column-tabs').evaluate(async (el) => {
      el.scrollLeft = el.scrollWidth;
      await new Promise((done) => setTimeout(done, 300));
      const last = el.lastElementChild as HTMLElement | null;
      const box = last?.getBoundingClientRect();
      return { onScreen: Boolean(box && box.right <= window.innerWidth + 1 && box.left >= -1) };
    });
    expect(namesReach.onScreen, 'the last column name must be reachable by scrolling its own row').toBe(true);
    await shoot(page, '02b-board-columns-swiped');

    // ---- 3. The chat tab, its list of chats shut and open. ---------------
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('restore-row').first().waitFor({ state: 'attached', timeout: WAIT });
    await page.waitForTimeout(1500);
    await judge(page, 'the chat tab, the list of chats shut', '03-chat-list-shut');

    await page.getByTestId('chat-rail-toggle').click();
    await expect(page.getByTestId('restore-row').first()).toBeInViewport({ timeout: WAIT });
    await page.waitForTimeout(800);
    await judge(page, 'the chat tab, the list of chats open', '04-chat-list-open');
    // A sheet that covered the bar would bury the button that opened it.
    expect(await pressable(page, 'chat-rail-toggle'), 'the toggle that opened the list must still be pressable').toBe(true);

    // ---- 4. A chat open. -------------------------------------------------
    await page.getByTestId('restore-row').first().getByTestId('row-name').click();
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(2000);
    await judge(page, 'a chat open', '05-chat-open');

    // ---- 5. The chat's right rail, its Chat view. ------------------------
    await page.getByTestId('chat-right-rail-toggle').click();
    await expect(page.getByTestId('chat-right-rail')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(1000);
    await judge(page, "the chat's right rail, its Chat view", '06-right-rail-chat');
    expect(await pressable(page, 'chat-git-toggle'), 'the Git button on the bar must not be under the open sheet').toBe(true);
    expect(await pressable(page, 'chat-right-rail-toggle'), 'the button that opened the rail must still be pressable').toBe(true);

    // ---- 6. The same rail, its Git view. ---------------------------------
    await page.getByTestId('chat-git-toggle').click();
    await expect(page.getByTestId('git-view')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(3000);
    await judge(page, "the chat's right rail, its Git view", '07-right-rail-git');

    // ---- 7. The git diff, and the one press back. ------------------------
    await page.getByTestId('git-diff-toggle').click();
    await page.getByTestId('git-diff-view').waitFor({ timeout: WAIT });
    await page.waitForTimeout(2500);
    if ((await page.getByTestId('diff-table').count()) === 0) {
      const open = page.getByTestId('git-diff-file-toggle').first();
      if (await open.count()) {
        await open.click();
        await page.waitForTimeout(2000);
      }
    }
    await expect(page.getByTestId('diff-table').first()).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(1000);
    await judge(page, 'the git diff', '08-git-diff');

    // The diff is only readable if it is on top: the Git sheet that opened it
    // used to lie over it (bw-e3dw.14).
    const onTop = await page.getByTestId('diff-table').first().evaluate((el) => {
      const box = el.getBoundingClientRect();
      const y = box.top + Math.min(box.height, window.innerHeight - box.top) / 2;
      let mine = 0;
      for (let x = 1; x < window.innerWidth; x += 1) {
        const on = document.elementFromPoint(x, y);
        if (on && (on === el || el.contains(on) || on.closest('[data-testid="git-diff-pane"]'))) mine += 1;
      }
      return mine;
    });
    note(`   the diff has ${onTop} of the ${PHONE.width} columns of the screen to itself`);
    expect(onTop, 'the diff must not be read from under the sheet that opened it').toBeGreaterThanOrEqual(PHONE.width - 4);

    await page.getByTestId('chat-diff-back').click();
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(800);
    await judge(page, 'back from the diff to the conversation', '09-back-from-the-diff');

    // ---- 8. The composer, and its @ menu with a keyboard up. -------------
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
    await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(1500);
    await judge(page, 'the composer', '10-composer');

    await keyboardUp(page, KEYBOARD);
    const writing = page.getByTestId('composer-frame').locator('.cm-content');
    await writing.click();
    await page.keyboard.type('@src/l');
    await page.waitForTimeout(2500);
    const menu = page.locator('.cm-tooltip-autocomplete').first();
    await expect(menu, 'the @ menu must be drawn').toBeVisible({ timeout: WAIT });
    const where = await menu.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        left: Math.round(box.left),
        right: Math.round(box.right),
        keyboardAt: Math.round(window.innerHeight - (window.visualViewport?.height ?? window.innerHeight)),
        window: { w: window.innerWidth, h: window.innerHeight },
      };
    });
    note(
      `   with a ${KEYBOARD}px keyboard up the @ menu is drawn from y=${where.top} to y=${where.bottom}, x=${where.left} to x=${where.right}`,
    );
    await judge(page, 'the composer and its @ menu, a keyboard up', '11-composer-at-menu');
    expect(where.bottom, 'the @ menu must be above the keyboard, which is exactly when it is needed').toBeLessThanOrEqual(
      where.window.h - KEYBOARD + 1,
    );
    expect(where.top, 'the @ menu must not be off the top of the screen either').toBeGreaterThanOrEqual(0);
    expect(where.left).toBeGreaterThanOrEqual(0);
    expect(where.right).toBeLessThanOrEqual(where.window.w + 1);
    await page.keyboard.press('Escape');

    // ---- 9. The Files tab: the tree as a sheet, the file the whole width.
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await expect(page.getByTestId('files-tab')).toHaveAttribute('data-root', fixture, { timeout: WAIT });
    await page.waitForTimeout(1500);
    const split = await page.evaluate(() => {
      const wide = (id: string) => {
        const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        return el ? Math.round(el.getBoundingClientRect().width) : -1;
      };
      const rail = document.querySelector<HTMLElement>('[data-testid="files-rail"]');
      return {
        rail: wide('files-rail'),
        railOpen: rail?.getAttribute('data-open'),
        viewer: wide('files-viewer'),
        window: window.innerWidth,
      };
    });
    note(`   the Files tab gives the viewer ${split.viewer}px of ${split.window}px while the tree is ${split.railOpen === 'true' ? 'open' : 'shut'}`);
    // Whichever way the tab opened: the tree is a sheet over the work area on
    // a phone, so it takes nothing off the width a file is read on (bw-e3dw.2).
    expect(split.viewer, 'a file is read on the whole width of the phone').toBeGreaterThanOrEqual(split.window - 1);

    await tree(page, 'open');
    await judge(page, 'the Files tab, the tree open as a sheet', '13-files-tree');
    expect(await pressable(page, 'files-rail-toggle'), 'the toggle that opened the tree must still be pressable').toBe(true);
    expect(await page.getByTestId('files-rail-scrim').getAttribute('data-open'), 'the sheet darkens what is behind it').toBe('true');

    await tree(page, 'shut');
    await judge(page, 'the Files tab, the tree shut and the file on the whole screen', '12-files-viewer');

    // ---- 10. A text file, then each preview kind. ------------------------
    const open = async (path: string, shot: string, screen: string) => {
      await tree(page, 'open');
      const steps = path.split('/');
      for (let depth = 1; depth < steps.length; depth += 1) {
        const folder = named(steps.slice(0, depth).join('/'));
        if ((await folder.count()) && (await folder.getAttribute('aria-expanded')) !== 'true') {
          await folder.click();
          await page.waitForTimeout(500);
        }
      }
      await named(path).click();
      await expect
        .poll(() => page.getByTestId('files-viewer').getAttribute('data-file'), { timeout: WAIT })
        .toBe(`${fixture}/${path}`);
      await page.waitForTimeout(1800);
      return judge(page, screen, shot);
    };

    await open('src/lib/deep.ts', '14-files-text', 'the Files tab, a text file');
    await open('README.md', '15-preview-markdown', 'the Files tab, a Markdown preview');

    // The exemption above says a fenced code block scrolls by itself. Prove
    // it is the block that holds the long line and not the page.
    const fenced = await page.evaluate(() => {
      const pre = document.querySelector<HTMLElement>('[data-testid="file-preview-markdown"] pre');
      if (!pre) return null;
      return {
        scroll: pre.scrollWidth,
        shown: pre.clientWidth,
        overflowX: getComputedStyle(pre).overflowX,
        right: Math.round(pre.getBoundingClientRect().right),
        window: window.innerWidth,
      };
    });
    expect(fenced, 'the Markdown fixture has a fenced code block in it').not.toBeNull();
    note(`   the fenced code block holds ${fenced!.scroll}px in ${fenced!.shown}px (overflow-x: ${fenced!.overflowX})`);
    // A line of code is never folded in half to make it fit; the block carries
    // its own sideways scroll for the ones that are too long, which is how
    // every Markdown reader draws one. Whether THIS line has to use it depends
    // on the type size the theme is drawing at, so what is asked is the
    // arrangement — the block is its own scroller and it stays on the screen —
    // rather than a number that would go green and red with the font.
    expect(fenced!.overflowX, 'a fenced block carries its own sideways scroll').toMatch(/auto|scroll/);
    expect(fenced!.right, 'and the block itself stays inside the screen').toBeLessThanOrEqual(fenced!.window + 1);

    await open('assets/drawing.svg', '16-preview-svg', 'the Files tab, an SVG preview');
    await open('assets/shot.png', '17-preview-image', 'the Files tab, a picture');

    // The exemption above says a picture opens at its real size and may be
    // clipped. Prove the stage is what clips it, and that the Fit button is
    // there to bring the whole picture back (bw-e3dw.17).
    const stage = await page.getByTestId('file-preview-image-stage').evaluate((el) => ({
      overflowX: getComputedStyle(el).overflowX,
      scale: el.getAttribute('data-scale'),
      right: Math.round(el.getBoundingClientRect().right),
      window: window.innerWidth,
    }));
    note(`   the picture's stage clips with overflow-x: ${stage.overflowX} at scale ${stage.scale}`);
    expect(stage.overflowX, 'the stage keeps an oversized picture to itself').not.toBe('visible');
    expect(stage.right, 'and the stage itself stays inside the screen').toBeLessThanOrEqual(stage.window + 1);
    await page.getByTestId('file-preview-fit').click();
    await page.waitForTimeout(800);
    const fitted = await page.getByTestId('file-preview-image').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { width: Math.round(box.width), window: window.innerWidth };
    });
    note(`   pressing Fit brings the picture to ${fitted.width}px in a ${fitted.window}px window`);
    expect(fitted.width, 'Fit means the whole picture is on the screen').toBeLessThanOrEqual(fitted.window + 1);
    await judge(page, 'the Files tab, a picture fitted to the screen', '18-preview-image-fitted');

    await open('assets/clip.mp4', '19-preview-video', 'the Files tab, a video');

    // ---- 11. The open-files strip, with every kind kept. -----------------
    // A click in the tree only ever previews, taking the one preview slot, so
    // the strip is filled the way a working reader fills it — with files that
    // were pinned, read back from where the app remembers them
    // (`open-files.ts`) — and is then crowded enough to have to swipe.
    await page.evaluate(({ id, at }) => {
      const files = ['README.md', 'src/main.ts', 'src/lib/deep.ts', 'assets/shot.png', 'assets/drawing.svg', 'assets/clip.mp4'];
      localStorage.setItem(
        `workbench.open-files.${id}`,
        JSON.stringify(files.map((path) => ({ path: `${at}/${path}`, preview: false }))),
      );
    }, { id: project.id, at: fixture });
    await page.goto(`/project?id=${project.id}&tab=files&file=${encodeURIComponent(`${fixture}/README.md`)}`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await page.waitForTimeout(2000);
    const kept = page.getByTestId('open-files-strip');
    await expect(kept).toBeVisible({ timeout: WAIT });
    const stripShape = await kept.evaluate((el) => ({
      shown: el.clientWidth,
      scroll: el.scrollWidth,
      overflowX: getComputedStyle(el).overflowX,
      tabs: el.querySelectorAll('[data-testid="open-file"]').length,
    }));
    note(`   ${stripShape.tabs} kept files: the strip shows ${stripShape.shown}px of ${stripShape.scroll}px (overflow-x: ${stripShape.overflowX})`);
    expect(stripShape.tabs, 'the strip is judged crowded, which is the case it has to be right in').toBeGreaterThan(4);
    expect(stripShape.overflowX, 'the strip of kept files swipes under a thumb').toMatch(/auto|scroll/);
    expect(stripShape.scroll, 'and it really is holding more than it shows, which is what the exemption is for').toBeGreaterThan(stripShape.shown);
    await judge(page, 'the Files tab, the strip of kept files', '20-files-strip');

    // ---- And the verdict. ------------------------------------------------
    expect(
      faults.map((one) => `${one.screen}: ${one.what}`),
      'every screen at 390px, with no horizontal scrolling and no control out of reach',
    ).toEqual([]);
    // The other half of the ratchet: a filed fault that has stopped happening
    // is a line to delete, here and on the card, in the turn that fixed it.
    expect(
      KNOWN.filter((one) => !knownSeen.has(`${one.screen}/${one.control}`)).map(
        (one) => `${one.control} on "${one.screen}" looks fixed: delete its line from KNOWN and close ${one.card}`,
      ),
      'the list of known faults says only what is still true',
    ).toEqual([]);
  } finally {
    const lines = [
      '',
      '======== THE APP ON A PHONE: EVERY SCREEN JUDGED AT 390x844 ========',
      '',
      ...measured,
      '',
      'Known faults, filed and not this case\'s to fix:',
      ...KNOWN.map((one) => `   ${one.control} on "${one.screen}" (${one.card}): ${one.why}`),
      '',
      'Exemptions, and why each is not a fault:',
      ...EXEMPT.map((one) => `   ${one.what}: ${one.because}`),
      `   a chip in a sentence: ${INLINE_CHIPS}`,
      '',
      faults.length ? `${faults.length} fault(s):` : 'No faults.',
      ...faults.map((one) => `   ${one.screen}: ${one.what}`),
      '',
      'Pictures:',
      ...shots.map((one) => `   ${one}`),
      '',
    ];
    const report = lines.join('\n');
    console.log(report);
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(`${SHOTS}/measurements.txt`, report);
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
