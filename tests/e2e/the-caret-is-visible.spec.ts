import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * What colour the chat's caret is actually painted, in each skin and in each
 * state the box can be in (bw-axtp.1).
 *
 * The owner reported the caret "becomes black or invisible sometimes". The
 * caret in the composer is not the browser's: `drawSelection()` covers the
 * native one with `caret-color: transparent !important` and paints a
 * `.cm-cursor` element of its own instead. So the question "what colour is the
 * caret" has two answers to read — the dead one on `.cm-content` and the live
 * one on `.cm-cursor` — and only the second is on screen.
 *
 * The caret is not the only thing `drawSelection()` draws without being told
 * what colour to use: the band under selected text comes from the same
 * baseTheme, and the same reading applies to it (bw-axtp.3). Both are read here
 * because both are answered in one place — src/workbench/drawn-marks.ts — and a
 * value that fixed one and broke the other would pass a spec that only looked
 * at one of them.
 *
 * A caret blinks, so nothing here waits to catch it lit: the colour is read off
 * the element with `getComputedStyle`, which the blink animation does not
 * touch (it moves opacity on the layer above, not the border colour). The
 * pictures are taken with animations disabled, which freezes the blink at its
 * first frame — fully opaque — so the caret is in every shot.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-caret-is-visible.spec.ts
 */

const STAGE = process.env.CARET_STAGE ?? 'after';
const SHOTS = `tests/results/caret/${STAGE}`;
/** The band's own pictures, kept apart from bw-axtp.1's evidence. */
const BANDS = `tests/results/selection/${STAGE}`;
const WAIT = 60_000;
const CHAT = 'caret-chat';
/** The chat's box, and the Files tab's editor: the app's two CodeMirrors. */
const COMPOSER = '.cm-editor';
const FILE = '[data-testid="files-viewer"] .cm-editor';

/**
 * Four skins, chosen so that both halves of the app's palette are asked: the
 * two darkest, one mid-dark, and one light. If the caret were painted from a
 * colour written into the code rather than from the live theme, exactly this
 * spread is what catches it — one of these four will disagree.
 */
const SKINS = [
  { id: 'default', mode: 'dark' as const },
  { id: 'catppuccin-mocha', mode: 'dark' as const },
  { id: 'catppuccin-frappe', mode: 'dark' as const },
  { id: 'github-clean', mode: 'light' as const },
];

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
  mkdirSync(where, { recursive: true });
  writeFileSync(join(where, 'README.md'), '# The caret\n');
  // A source file, because the Files tab opens Markdown as a reading and only
  // code lands in CodeMirror — and CodeMirror is what this case is about.
  mkdirSync(join(where, 'src'), { recursive: true });
  writeFileSync(join(where, 'src', 'jobs.ts'), 'export const CARET = "a line to put a caret in";\n');
  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Caret');
  git(where, 'config', 'user.email', 'caret@atelier.test');
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

async function wearSkin(page: Page, id: string, mode: 'dark' | 'light'): Promise<void> {
  await page.evaluate(
    ({ id, mode }) => {
      const html = document.documentElement;
      localStorage.setItem('beads-theme', id);
      if (id === 'default') html.removeAttribute('data-theme');
      else html.setAttribute('data-theme', id);
      html.classList.toggle('dark', mode === 'dark');
      html.classList.toggle('light', mode === 'light');
      window.dispatchEvent(new CustomEvent('theme-change'));
    },
    { id, mode },
  );
  await page.waitForTimeout(300);
}

interface Reading {
  /** `caret-color` on `.cm-content`: what the browser would paint, if it painted one. */
  native: string;
  /** The drawn caret's own colour, and whether it is on screen at all. */
  drawn: string | null;
  drawnShown: boolean;
  drawnCount: number;
  /** The first opaque background behind the writing area. */
  behind: string;
  /** The drawn caret's colour against that background, WCAG contrast. */
  contrast: number | null;
  /** The selection band as the eye sees it, or null when nothing is selected. */
  band: string | null;
  /** The writing, over the band it is sitting on. */
  ink: string | null;
  /** The band against the box behind it: can you see where the selection is. */
  bandOnBox: number | null;
  /** The writing against the band: can you still read what you selected. */
  inkOnBand: number | null;
  focused: boolean;
}

/**
 * What is on screen right now. Everything is read from computed style, so the
 * answer does not depend on catching the blink lit.
 */
async function look(page: Page, which: string): Promise<Reading> {
  return page.evaluate((which: string) => {
    const parse = (c: string): [number, number, number, number] => {
      const n = c.match(/[\d.]+/g)?.map(Number) ?? [];
      return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1];
    };
    const opaque = (el: Element | null): string => {
      for (let at: Element | null = el; at; at = at.parentElement) {
        const bg = getComputedStyle(at).backgroundColor;
        if (parse(bg)[3] > 0.99) return bg;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const luminance = (c: string) => {
      const [r, g, b] = parse(c);
      const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    // The caret can be part-transparent; what the eye sees is it over its backdrop.
    const over = (fg: string, bg: string) => {
      const f = parse(fg);
      const b = parse(bg);
      const a = f[3];
      return `rgb(${[0, 1, 2].map((i) => Math.round(f[i] * a + b[i] * (1 - a))).join(', ')})`;
    };

    const editor = document.querySelector(which);
    const content = editor?.querySelector('.cm-content') ?? null;
    const band = editor?.querySelector('.cm-selectionBackground') ?? null;
    const cursors = Array.from(editor?.querySelectorAll('.cm-cursor') ?? []);
    const primary = (cursors[0] ?? null) as HTMLElement | null;
    const behind = opaque(content);
    const drawnRaw = primary ? getComputedStyle(primary).borderLeftColor : null;
    const shown = primary ? getComputedStyle(primary).display !== 'none' : false;
    const seen = drawnRaw ? over(drawnRaw, behind) : null;
    const ratio = (a: string, b: string) => {
      const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
      return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
    };
    // The band is drawn in a layer under the writing, so what the eye sees is
    // the band over the box, and the writing over that.
    const bandSeen = band ? over(getComputedStyle(band).backgroundColor, behind) : null;
    const inkSeen = content && bandSeen ? over(getComputedStyle(content).color, bandSeen) : null;
    return {
      native: content ? getComputedStyle(content).caretColor : 'no content',
      drawn: seen,
      drawnShown: shown,
      drawnCount: cursors.length,
      behind,
      contrast: seen ? ratio(seen, behind) : null,
      band: bandSeen,
      ink: inkSeen,
      bandOnBox: bandSeen ? ratio(bandSeen, behind) : null,
      inkOnBand: inkSeen && bandSeen ? ratio(inkSeen, bandSeen) : null,
      focused: !!editor?.classList.contains('cm-focused'),
    };
  }, which);
}

/**
 * What a selected line has to clear.
 *
 * The writing on the band is ordinary body text — 15px in the chat's box, 13px
 * of code in the Files tab — so AA's 4.5:1 is the number it answers to, read
 * against the band rather than against the page, because the band is what is
 * behind it while it is selected.
 *
 * The band against the box is not text and WCAG has no rule for it. 1.2:1 is
 * the floor taken here, and it is set from what was measured rather than
 * chosen first: the tightest of the eight readings is the Default Dark box,
 * whose surface is nearly black, at 1.21:1 — and the picture beside this file
 * (tests/results/selection/after/default-a-line-selected.png) shows a band
 * that is plainly there. The ratio understates a difference at that end of the
 * range: its +0.05 term is most of both sides of the fraction when the darker
 * colour is rgb(9, 9, 11). A skin that came out below this is one where the
 * band has stopped being a mark and become a tint (bw-axtp.3).
 */
const READABLE_ON_BAND = 4.5;
const BAND_IS_VISIBLE = 1.2;

/** Both judgements on one selected line, in the words a failure should read in. */
function judgeBand(where: string, seen: Reading): string[] {
  if (!seen.band) return [`${where}: nothing is drawn under the selected line at all`];
  const bad: string[] = [];
  if ((seen.inkOnBand ?? 0) < READABLE_ON_BAND)
    bad.push(`${where}: the writing is ${seen.ink} on a band of ${seen.band} — ${seen.inkOnBand ?? '—'}:1`);
  if ((seen.bandOnBox ?? 0) < BAND_IS_VISIBLE)
    bad.push(`${where}: the band is ${seen.band} on ${seen.behind} — ${seen.bandOnBox ?? '—'}:1, no edge to see`);
  return bad;
}

/** One line of the record, for a state where something is selected. */
function bandNote(where: string, seen: Reading): string {
  return (
    `${where}: the band is ${seen.band ?? 'not drawn'} on ${seen.behind} = ${seen.bandOnBox ?? '—'}:1; ` +
    `the writing on it ${seen.ink ?? '—'} = ${seen.inkOnBand ?? '—'}:1; ` +
    `${seen.focused ? 'focused' : 'not focused'}`
  );
}

test('the caret and the selection band in the chat and in the Files tab, in four skins and in every state each box can be in', async ({ page, request }) => {
  test.setTimeout(600_000);
  const fixture = join(__dirname, '..', '.workbench-run-caret');
  seed(fixture);

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'claude-opus-5', cwd: fixture, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: 'A short answer, so the box has something above it.' },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];

  await page.addInitScript(
    ({ chat, view }) => {
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
    },
    { chat: CHAT, view: foldAll(events) },
  );

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
        title: 'A chat whose caret is looked at',
        cwd: fixture,
        beads: [],
      },
    }),
  );

  const project = await fixtureProject(request, 'caret', fixture);
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(BANDS, { recursive: true });
  const wrong: string[] = [];

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const skin of SKINS) {
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
      await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
      await wearSkin(page, skin.id, skin.mode);
      const content = page.locator('.cm-content').first();
      await expect(content).toBeVisible({ timeout: WAIT });
      const box = page.locator('.cm-editor').first();

      // The five states the box passes through in ordinary use. Each is read
      // before the next is entered, so "sometimes" has somewhere to show up.
      const states: { name: string; enter: () => Promise<void> }[] = [
        { name: 'resting, never touched', enter: async () => {} },
        {
          name: 'focused and empty',
          enter: async () => {
            await content.click();
          },
        },
        {
          name: 'focused with a line typed',
          enter: async () => {
            await page.keyboard.type('a line he is writing');
          },
        },
        {
          name: 'blurred by a click outside',
          enter: async () => {
            await page.getByTestId('transcript').click({ position: { x: 10, y: 10 } });
          },
        },
        {
          name: 'focused again, caret back in the middle',
          enter: async () => {
            await content.click();
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('ArrowLeft');
          },
        },
      ];

      for (const state of states) {
        await state.enter();
        await page.waitForTimeout(250);
        const seen = await look(page, COMPOSER);
        note(
          `${skin.id} · ${state.name}: ${seen.focused ? 'focused' : 'not focused'}; ` +
            `${seen.drawnCount} drawn caret(s), ${seen.drawnShown ? 'shown' : 'not shown'}; ` +
            `drawn ${seen.drawn ?? 'none'} on ${seen.behind} = ${seen.contrast ?? '—'}:1; ` +
            `native caret-color ${seen.native}`,
        );
        await box.screenshot({
          path: `${SHOTS}/${skin.id}-${state.name.replace(/[^a-z]+/gi, '-')}.png`,
          animations: 'disabled',
        });

        // Judged only where a caret is actually on screen. An unfocused box
        // draws none, and that is right — a box nobody is typing in has no
        // caret to see.
        if (!seen.drawnShown) continue;
        if (seen.contrast === null || seen.contrast < 3) {
          wrong.push(
            `${skin.id}, ${state.name}: the caret is ${seen.drawn} on ${seen.behind} — ${seen.contrast ?? '—'}:1`,
          );
        }
      }
      // The line he just wrote, selected. Read the same way as the caret and
      // judged on both sides at once: the writing on the band, and the band on
      // the box (bw-axtp.3).
      await content.click();
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(200);
      const selected = await look(page, COMPOSER);
      note(bandNote(`${skin.id} · a line selected`, selected));
      await box.screenshot({ path: `${BANDS}/${skin.id}-a-line-selected.png`, animations: 'disabled' });
      wrong.push(...judgeBand(`${skin.id}, a line selected in the chat's box`, selected));

      // Emptied, so the next skin starts from the same box.
      await page.keyboard.press('Backspace');
    }

    // ── The Files tab's editor, the app's other CodeMirror ────────────────
    // Same question, asked of the sibling, because a caret painted from a
    // colour written into the code would be wrong in both places and one
    // answer has to cover both. This one is read-only until a key is pressed,
    // so it is walked read-only first: a view nobody can type into still shows
    // a caret when it has focus, and that caret is as easy to lose.
    for (const skin of SKINS) {
      await page.goto(`/project?id=${project.id}&tab=files`);
      await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
      await wearSkin(page, skin.id, skin.mode);
      const row = (path: string) => page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/${path}"]`);
      await row('src').click({ timeout: WAIT });
      await row('src/jobs.ts').click({ timeout: WAIT });
      const viewer = page.getByTestId('files-viewer');
      await expect(viewer.locator('.cm-content')).toContainText('CARET', { timeout: WAIT });

      const steps: { name: string; enter: () => Promise<void> }[] = [
        { name: 'read-only, never touched', enter: async () => {} },
        {
          name: 'read-only, clicked into',
          enter: async () => {
            await viewer.locator('.cm-line').first().click();
          },
        },
        {
          name: 'editable, a line typed',
          enter: async () => {
            await page.keyboard.press('End');
            await page.keyboard.press('x');
            await expect(viewer.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
            await page.keyboard.type('yz');
          },
        },
      ];
      for (const step of steps) {
        await step.enter();
        await page.waitForTimeout(250);
        const seen = await look(page, FILE);
        note(
          `files · ${skin.id} · ${step.name}: ${seen.focused ? 'focused' : 'not focused'}; ` +
            `${seen.drawnCount} drawn caret(s), ${seen.drawnShown ? 'shown' : 'not shown'}; ` +
            `drawn ${seen.drawn ?? 'none'} on ${seen.behind} = ${seen.contrast ?? '—'}:1; ` +
            `native caret-color ${seen.native}`,
        );
        await viewer.screenshot({
          path: `${SHOTS}/files-${skin.id}-${step.name.replace(/[^a-z]+/gi, '-')}.png`,
          animations: 'disabled',
        });
        if (!seen.drawnShown) continue;
        if (seen.contrast === null || seen.contrast < 3) {
          wrong.push(
            `the Files tab in ${skin.id}, ${step.name}: the caret is ${seen.drawn} on ${seen.behind} — ${seen.contrast ?? '—'}:1`,
          );
        }
      }

      // The band in the other editor, which is where its colour was answered
      // first. Read twice: with the view focused, and with the focus taken
      // away — this one is read-only at rest, so a band that only shows while
      // the view has focus would leave a reader unable to see what he has
      // selected the moment he reaches for anything else.
      await viewer.locator('.cm-line').first().click();
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(200);
      const held = await look(page, FILE);
      note(bandNote(`files · ${skin.id} · a line selected`, held));
      await viewer.screenshot({ path: `${BANDS}/files-${skin.id}-a-line-selected.png`, animations: 'disabled' });
      wrong.push(...judgeBand(`the Files tab in ${skin.id}, a line selected`, held));

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.waitForTimeout(200);
      const dropped = await look(page, FILE);
      note(bandNote(`files · ${skin.id} · a line selected, focus taken away`, dropped));
      await viewer.screenshot({ path: `${BANDS}/files-${skin.id}-selected-unfocused.png`, animations: 'disabled' });
      wrong.push(...judgeBand(`the Files tab in ${skin.id}, selected then left`, dropped));

      // Put the file back before leaving it. An unsaved file installs a
      // `beforeunload` handler (src/workbench/unsaved-files.ts), and a
      // navigation answered by that dialog would strand the next skin.
      for (let undo = 0; undo < 5; undo++) {
        if ((await page.getByTestId('open-file-dirty').count()) === 0) break;
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(200);
      }
      await expect(page.getByTestId('open-file-dirty')).toHaveCount(0, { timeout: WAIT });
    }

    expect(wrong, 'something drawSelection draws is invisible against the box it sits in').toEqual([]);
  } finally {
    const record = measured.map((m) => `- ${m}`).join('\n') + '\n';
    writeFileSync(`${SHOTS}/measurements.txt`, record);
    writeFileSync(`${BANDS}/measurements.txt`, record);
    // eslint-disable-next-line no-console
    console.log(`\n${measured.map((m) => `- ${m}`).join('\n')}\n`);
    await request.delete(`/api/projects/${project.id}`).catch(() => {});
  }
});
