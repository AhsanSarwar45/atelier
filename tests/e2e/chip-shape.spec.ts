import { expect, test } from '@playwright/test';

import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { PARENT_CARD, discardFixture, makeFixtureProject } from './fixture-board';

/**
 * The shape of a chip, drawn big enough to argue about.
 *
 * Three faults live in the one shared badge and none of them is more than two
 * pixels, so a shot at the screen's own density proves nothing either way.
 * Every shot here is taken at four times that density and cropped to the chips
 * themselves (bw-s5op).
 */

const CHAT = 'chip-shape-fixture';
const SHOT = process.env.CHIP_SHAPE_DIR || 'tests/results/chip-shape';

const DSF = Number(process.env.CHIP_DSF || 4);
test.use({ deviceScaleFactor: DSF });

// `bd init` writes a Dolt database and installs four sets of hooks before the
// browser is opened at all, and on a busy machine that alone spends the default
// deadline (tests/e2e/fixture-board.ts).
test.setTimeout(240_000);

test('every chip in the app draws the same box', async ({ page, request }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  const run = join(process.cwd(), 'tests', '.workbench-run-chip-shape');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const text = [
    'Two independent hook problems are now fixed.',
    '',
    '- [board-actor.py](</home/ahsan/dev/beads-web/scripts/hooks/board-actor.py:96>) now returns updatedInput.',
    '- [.codex/hooks.json](</home/ahsan/dev/beads-web/.codex/hooks.json:51>) no longer loads twice.',
    '',
    '- In code: [`board-actor.py`](</home/ahsan/dev/beads-web/scripts/hooks/board-actor.py:96>) now returns updatedInput.',
    '  - Nested under it: [`.codex/hooks.json`](</home/ahsan/dev/beads-web/.codex/hooks.json:51>) no longer loads twice.',
    '',
    '> Quoted: [board-actor.py](</home/ahsan/dev/beads-web/scripts/hooks/board-actor.py:96>) still.',
    '',
    '**Bold around it: [board-actor.py](</home/ahsan/dev/beads-web/scripts/hooks/board-actor.py:96>) still.**',
    '',
    'In a heading:',
    '',
    '### [board-actor.py](</home/ahsan/dev/beads-web/scripts/hooks/board-actor.py:96>)',
  ].join('\n');
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    {
      ...base,
      seq: 1,
      type: 'session.started',
      brand: 'claude',
      externalId: 'fixture',
      model: 'claude-opus-5[1m]',
      cwd: projectPath,
      permissionMode: 'bypassPermissions',
      effort: 'high',
    },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text },
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
          setTimeout(
            () =>
              this.onmessage?.(
                new MessageEvent('message', {
                  data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
                }),
              ),
            0,
          );
      }
      close() {
        this.readyState = FixtureSocket.CLOSED;
      }
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: [
        {
          sessionId: CHAT,
          externalId: 'fixture',
          brand: 'claude',
          title: 'Chip shapes',
          state: 'idle',
          lastActiveAt: new Date(0).toISOString(),
          cwdHint: projectPath,
          runningElsewhere: false,
          held: null,
          beads,
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
        title: 'Chip shapes',
        cwd: projectPath,
        beads,
      },
    }),
  );

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'Chip shape fixture', path: projectPath, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Chip shapes' }).getByTestId('row-name').click();
    await expect(page.getByText('Two independent hook problems')).toBeVisible();

    // Where a chip's label box sits inside its pill. The badge centres the box
    // and then lowers it by exactly one pixel, because the visible top of Latin
    // text is its cap height rather than the font's ascent (see the comment on
    // `badgeVariants`). So a correctly built chip reads +1 here: centred, and
    // corrected once. A caller that nudges its own label again reads +2, and a
    // chip the shared rule cannot reach reads 0 (bw-s5op.1).
    const LOWERED_BY = async () => page.evaluate(() => {
      const out: { id: string; text: string; by: number }[] = [];
      const look = (id: string) => {
        for (const chip of document.querySelectorAll(`[data-testid="${id}"]`)) {
          const label = chip.querySelector(':scope > span:not([data-slot])');
          if (!label) continue;
          const a = label.getBoundingClientRect();
          const b = chip.getBoundingClientRect();
          out.push({ id, text: (label.textContent || '').slice(0, 20), by: +(a.top + a.height / 2 - (b.top + b.height / 2)).toFixed(2) });
        }
      };
      for (const id of ['session-brand', 'chat-model-chip', 'chat-mode-chip', 'chat-effort-chip', 'chat-folder-chip', 'markdown-file-link']) look(id);
      return out;
    });

    // 1. The status line: brand, model, mode, effort and folder chips.
    await expect(page.getByTestId('chat-mode-chip')).toBeVisible();
    await page.getByTestId('chat-status-line').screenshot({ path: `${SHOT}/chip-status-line.png` });

    // 2. The rail's card chips.
    const rail = page.getByTestId('chat-right-rail');
    if ((await rail.getAttribute('data-open')) !== 'true') await page.getByTestId('chat-right-rail-toggle').click();
    const cards = page.getByTestId('rail-cards');
    await expect(cards).toBeVisible();
    await expect(page.getByTestId('bead-chip').first()).toBeVisible();
    await cards.screenshot({ path: `${SHOT}/chip-rail-cards.png` });
    // Every chip's letters sit on the middle of their own pill, whatever is
    // nested inside it and whatever font it is drawn in. Half a pixel is the
    // tolerance because a 20px pill has no exact middle row at density 1.
    const lowered = await LOWERED_BY();
    expect(lowered.length, 'the status line and the file chips must both be on screen').toBeGreaterThanOrEqual(8);
    for (const chip of lowered)
      expect(chip.by, `${chip.id} "${chip.text}" is lowered ${chip.by}px, not the shared 1px`).toBeCloseTo(1, 1);

    // 3. The file chips written into a message.
    const links = page.getByTestId('markdown-file-link');
    await expect(links).toHaveCount(7);
    const first = (await links.first().boundingBox())!;
    const last = (await links.last().boundingBox())!;
    await page.screenshot({
      path: `${SHOT}/chip-file-links.png`,
      clip: { x: first.x - 14, y: first.y - 10, width: 490, height: last.y + last.height + 10 - (first.y - 10) },
    });

  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
