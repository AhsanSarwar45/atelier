/**
 * A Claude chat's gauge shows the window Claude Code measures against.
 *
 * The bundled adapter guessed the window until a turn ended: a "1m" in the
 * model's name, else 200k. A chat on a plain `opus` alias, or one that had just
 * woken on a fresh adapter, read `…/200k` through its whole first turn and then
 * jumped to the model's raw `1M` — while the CLI itself compacts at the
 * configured `autoCompactWindow`. The manager: "the context isnt shown
 * correclty for this chat ... that project has the token compaction limit set
 * at 256k but here it shows the limit at 200k" (bw-si0em).
 *
 * Live, because the figure under test is the one a real CLI reports.
 *
 *   BEADS_E2E_LIVE_PROVIDERS=1 scripts/workbench-e2e.sh tests/e2e/a-claude-chat-shows-its-real-window.spec.ts
 *
 * Against the build before the fix, THE_GAUGE_GUESSED=1 records the guess
 * instead of refusing it, for the before picture.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-real-window');
const SHOTS = 'tests/results';
const TURN_MS = 600_000;
const SETTLE_MS = 180_000;
/** What the project tells the CLI to compact at, so the CLI measures against it. */
const COMPACT_AT = 256_000;
const GUESSED = Boolean(process.env.THE_GAUGE_GUESSED);
const SHOT = GUESSED ? 'bw-si0em-before' : 'bw-si0em-after';
/** Long enough that the gauge is drawn several times before the turn ends. */
const ASKED = 'Count from 1 to 60, one number per line, then write DONE. Do not use any tools.';

/** Every window the gauge shows from now until the answer ends with DONE. */
async function windowsThroughATurn(page: Page, shot: string): Promise<number[]> {
  const seen = new Set<number>();
  let pictured = false;
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    const chip = page.getByTestId('context-chip');
    const shown = await chip.getAttribute('data-window', { timeout: 200 }).catch(() => null);
    if (shown) {
      seen.add(Number(shown));
      if (!pictured) {
        pictured = true;
        await page.screenshot({ path: `${SHOTS}/${shot}.png`, clip: { x: 0, y: 0, width: 1280, height: 160 } });
      }
    }
    const answer = await page.getByTestId('assistant-message').last().textContent({ timeout: 200 }).catch(() => '');
    if (answer?.includes('DONE') && !(await page.getByText('Working').first().isVisible().catch(() => false))) break;
    await page.waitForTimeout(100);
  }
  const last = await page.getByTestId('context-chip').getAttribute('data-window');
  if (last) seen.add(Number(last));
  return [...seen];
}

test.describe('a Claude chat and its context window', () => {
  test.describe.configure({ mode: 'serial', timeout: TURN_MS });

  test.skip(
    process.env.BEADS_E2E_LIVE_PROVIDERS !== '1',
    'needs a live provider: only a real CLI says what window it measures against',
  );

  test.beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });

  test('shows the window the CLI reports from the first turn, and again after waking', async ({ page, request }) => {
    let project: Project | undefined;
    try {
      const path = join(ROOT, 'real-window');
      mkdirSync(join(path, '.claude'), { recursive: true });
      // The manager's own shape: a pinned 1M alias, and a compaction window
      // below it. The CLI measures against the smaller of the two.
      writeFileSync(join(path, '.claude', 'settings.json'), `${JSON.stringify({
        model: 'opus[1m]',
        autoCompactEnabled: true,
        autoCompactWindow: COMPACT_AT,
      }, null, 2)}\n`);
      const made = await request.post('/api/projects', {
        data: { name: 'real-window', path, isTest: true },
      });
      expect(made.status(), await made.text()).toBe(201);
      project = (await made.json()) as Project;

      const started = await request.post('/api/workbench/command', {
        data: {
          type: 'session.start',
          projectId: project.id,
          projectPath: project.path,
          brand: 'claude',
          model: 'opus',
          permissionMode: 'bypassPermissions',
        },
      });
      expect(started.ok(), await started.text()).toBe(true);
      const sessionId = ((await started.json()) as { id: string }).id;

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const url = new URL(route.request().url());
        url.searchParams.set('include_test', 'true');
        await route.continue({ url: url.toString() });
      });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: SETTLE_MS });

      // A fresh chat's first turn.
      await request.post('/api/workbench/command', { data: { type: 'prompt.send', sessionId, text: ASKED } });
      const fresh = await windowsThroughATurn(page, `${SHOT}-fresh`);

      // Asleep, then woken on a new adapter: the case the manager saw.
      const stopped = await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId } });
      expect(stopped.ok(), await stopped.text()).toBe(true);
      await request.post('/api/workbench/command', { data: { type: 'prompt.send', sessionId, text: ASKED } });
      await expect(page.getByTestId('assistant-message')).toHaveCount(2, { timeout: SETTLE_MS });
      const woken = await windowsThroughATurn(page, `${SHOT}-woken`);

      writeFileSync(join(SHOTS, `${SHOT}.json`), `${JSON.stringify({ fresh, woken }, null, 2)}\n`);
      if (GUESSED) {
        expect([...fresh, ...woken]).toContain(200_000);
        return;
      }
      expect(fresh).toEqual([COMPACT_AT]);
      expect(woken).toEqual([COMPACT_AT]);
    } finally {
      if (project) await request.delete(`/api/projects/${project.id}`);
    }
  });
});
