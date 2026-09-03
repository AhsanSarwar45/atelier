import { expect, test, type Page } from '@playwright/test';

import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { PARENT_CARD, makeFixtureProject } from './fixture-board';

/**
 * Where a status-line chip's letters actually land, at the density they are
 * actually read at.
 *
 * The measurement this replaces compared the label span's box with the chip's
 * box. Both are laid out by the same centring flexbox, so that difference is
 * whatever `top` the label carries and nothing else — it reports the nudge back
 * to you and calls it a result. It read "centred" on a screen where the letters
 * are visibly low (bw-r8iy).
 *
 * So: shoot the real chips, and let the pixels say where the ink is. Once per
 * device scale, because a 20px pill holding a 15px line box has 2.5px of room
 * above and below, and 2.5px is not a whole pixel at scale 1 -- which is the
 * only scale anybody looks at.
 */

const CHAT = 'chip-centering-fixture';
const SHOT = process.env.CHIP_CENTER_DIR || 'tests/results/chip-centering';
const SCALES = (process.env.CHIP_CENTER_SCALES || '1,2,3').split(',').map(Number);

test.setTimeout(300_000);

/** The fixture chat, with the status line the report was filed against. */
async function mount(page: Page, projectPath: string) {
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    {
      ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture',
      model: 'claude-opus-5[1m]', cwd: projectPath, permissionMode: 'bypassPermissions', effort: 'high',
    },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: 'Chips above this line.' },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const snapshot = foldAll(events);
  const beads = [PARENT_CARD, 'wl-kid1', 'wl-kid2'];

  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') === chat)
          setTimeout(() => this.onmessage?.(new MessageEvent('message', {
            data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
          })), 0);
      }
      close() { this.readyState = FixtureSocket.CLOSED; }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, view: snapshot });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const session = {
    sessionId: CHAT, externalId: 'fixture', brand: 'claude', title: 'Chip centering',
    state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath,
    origin: 'terminal', cwd: projectPath, runningElsewhere: false, held: null, beads,
  };
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [session] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: session }));
}


/**
 * Where the letters sit, exactly, in CSS pixels and at any density.
 *
 * Ink thresholds cannot answer a one-pixel question: antialiasing spreads a
 * glyph edge over more device rows as the density rises, so the same chip
 * measures differently at 1x and at 3x. These two numbers do not move.
 *
 *  - The baseline comes from a zero-size inline-block strut appended to the
 *    label. An inline-block with no content sits with its bottom margin edge on
 *    the line's baseline, so its own bottom IS the baseline.
 *  - The cap height comes from the font itself, through a canvas measuring the
 *    chip's own computed font shorthand.
 *
 * The visible block of Latin text runs from the cap line to the baseline, so
 * its middle is `baseline - capHeight / 2`. Centred means that equals the
 * middle of the pill.
 */
async function offsets(page: Page) {
  return page.evaluate(() => {
    const out: { chip: string; text: string; off: number }[] = [];
    for (const chip of document.querySelectorAll('[data-slot="badge"]')) {
      const label = chip.querySelector(':scope > span:not([data-slot])') as HTMLElement | null;
      if (!label || !(label.textContent || '').trim()) continue;
      const strut = document.createElement('span');
      strut.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0';
      label.appendChild(strut);
      const baseline = strut.getBoundingClientRect().bottom;
      strut.remove();
      const font = getComputedStyle(label).font || getComputedStyle(chip).font;
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = font;
      const cap = ctx.measureText('H').actualBoundingBoxAscent;
      const box = chip.getBoundingClientRect();
      out.push({
        chip: chip.getAttribute('data-testid') || chip.className.slice(0, 18),
        text: (label.textContent || '').trim().slice(0, 18),
        off: +((baseline - cap / 2) - (box.top + box.height / 2)).toFixed(3),
      });
    }
    return out;
  });
}

test('a status-line chip carries its letters in the middle of its pill', async ({ browser, request }) => {
  const run = join(process.cwd(), 'tests', '.workbench-run-chip-centering');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'Chip centering fixture', path: projectPath, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();

    for (const scale of SCALES) {
      const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1200, height: 760 } });
      const page = await context.newPage();
      await mount(page, projectPath);
      await page.goto(`/project?id=${project!.id}&tab=chat`);
      await page.getByTestId('restore-row').filter({ hasText: 'Chip centering' }).getByTestId('row-name').click();
      await expect(page.getByTestId('chat-mode-chip')).toBeVisible();

      // As it ships.
      await page.getByTestId('chat-status-line').screenshot({ path: `${SHOT}/x${scale}-nudged.png` });
      console.log(`OFFSETS x${scale} nudged ` + JSON.stringify(await offsets(page)));
      // And with the one-pixel correction taken back out, so the shots can be
      // told apart by the only thing that differs between them.
      await page.addStyleTag({ content: '[data-slot="badge"] > span:not([data-slot]) { top: 0 !important; }' });
      await page.getByTestId('chat-status-line').screenshot({ path: `${SHOT}/x${scale}-plain.png` });
      console.log(`OFFSETS x${scale} plain  ` + JSON.stringify(await offsets(page)));
      await context.close();
    }
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
  }
});
