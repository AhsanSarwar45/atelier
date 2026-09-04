/**
 * A widget is drawn when its block closes, not when the turn does (bw-t26l.20).
 *
 * Three widgets sat on the manager's screen as raw JSON in a code block while
 * the turn that wrote them went on working for another hour. They were read
 * off the words only when the turn ended, and an agent's turn ends when it has
 * finished working — which for a long piece of work is nowhere near when it
 * spoke.
 *
 * Live, because the thing under test is when a real provider's chunks arrive
 * relative to the end of a real turn. A fixture would decide that by hand and
 * prove nothing about it.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-widget-mid-turn');
const SHOTS = 'tests/results';
const TURN_MS = 600_000;
const SETTLE_MS = 90_000;

/** The exact bytes the agent is asked to write, and what must be on screen. */
const WIDGET = '{"type":"table","columns":["Case","Result"],"rows":[["mid-turn","drawn"]]}';

test.describe('a widget is drawn while the turn runs', () => {
  test.describe.configure({ mode: 'serial', timeout: TURN_MS });

  test.beforeAll(() => {
    expect(process.env.BEADS_E2E_LIVE_PROVIDERS, 'set BEADS_E2E_LIVE_PROVIDERS=1').toBe('1');
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });

  test('the block is a table on screen before the work that follows it finishes', async ({ page, request }) => {
    let project: Project | undefined;
    try {
      const path = join(ROOT, 'mid-turn');
      mkdirSync(path, { recursive: true });
      const made = await request.post('/api/projects', { data: { name: 'widget-mid-turn', path, isTest: true } });
      expect(made.status(), await made.text()).toBe(201);
      project = (await made.json()) as Project;

      const started = await request.post('/api/workbench/command', {
        data: {
          type: 'session.start',
          projectId: project.id,
          projectPath: project.path,
          brand: 'claude',
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
      await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });

      const sent = await request.post('/api/workbench/command', {
        data: {
          type: 'prompt.send',
          sessionId,
          text:
            'Do these three things in order, and nothing else.\n' +
            '1. Say exactly this, as a fenced block, on its own:\n' +
            '```atelier-widget\n' +
            `${WIDGET}\n` +
            '```\n' +
            '2. Then run exactly one Bash command: sleep 40\n' +
            '3. When it returns, reply exactly WIDGET DONE.\n' +
            'Do not read any file, do not run any other command, and do not say anything else.',
        },
      });
      expect(sent.ok(), await sent.text()).toBe(true);

      // Drawn as a table while the turn is still in the `sleep 40` it was told
      // to run afterwards. This is the whole case: the words are on screen and
      // so is the picture they asked for, and the turn has not ended.
      const widget = page.locator('[data-testid="chat-widget"][data-widget="table"]');
      await expect(widget).toBeVisible({ timeout: SETTLE_MS });
      await expect(widget).toContainText('mid-turn');
      // Scoped to what the agent said: the prompt that asked for all of this
      // is on the page too, and it contains both of these strings.
      const said = page.getByTestId('assistant-message');
      await expect(said.filter({ hasText: 'WIDGET DONE' })).toHaveCount(0);
      // And the JSON that made it is not also sitting on the page as text.
      await expect(said.filter({ hasText: '"type":"table"' })).toHaveCount(0);
      // The work under it says what it is, too. A pending Bash call opens
      // titled `Terminal`, and a command that prints nothing is never
      // mentioned again — the chip has to be read off the call.
      await expect(page.getByTestId('ran-terminal-command').last()).toContainText('sleep 40');
      await page.screenshot({ path: `${SHOTS}/a-widget-is-drawn-while-the-turn-runs.png` });

      // When the turn does end, it is still one table and not two: a block
      // that has been drawn is not read a second time.
      await expect(page.getByTestId('assistant-message').last()).toContainText('WIDGET DONE', { timeout: SETTLE_MS });
      await expect(widget).toHaveCount(1);

      // And one table when the chat is read back from the record.
      await page.reload();
      await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
      await expect(page.locator('[data-testid="chat-widget"][data-widget="table"]')).toHaveCount(1);
    } finally {
      if (project) await request.delete(`/api/projects/${project.id}`);
    }
  });
});
