/**
 * What the presenter showed is drawn without the agent pasting it (bw-yh4nu).
 *
 * The chat used to draw a widget only from a block the agent copied out of the
 * presenter's output into its reply, and a quarter of every block presented
 * never reached a reply. The call's own output is the source now: the widget
 * is drawn right after the call, once, live and when the chat is read back.
 * An agent that pastes it anyway still gets one widget, not two.
 *
 * Live, because what is under test is what a real provider hands back for a
 * real shell call, and where that lands in a real turn.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-presented-widget');
const SHOTS = 'tests/results';
const TURN_MS = 600_000;
const SETTLE_MS = 180_000;

const WIDGET = '{"type":"table","columns":["Case","Result"],"rows":[["no paste","drawn"]]}';
const PRESENT = `printf '%s' '${WIDGET}' | atelier tool present widget`;

const ask = (paste: boolean) =>
  'Do these things in order, and nothing else.\n' +
  `1. Run exactly this one shell command: ${PRESENT}\n` +
  (paste
    ? '2. Then reply with the exact output of that command, followed by the words PRESENTED DONE.\n'
    : '2. Then reply exactly PRESENTED DONE, and nothing else. Do not repeat the command output.\n') +
  'Do not read any file and do not run any other command.';

async function openChat(page: Page, project: Project, sessionId: string) {
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
}

/**
 * The presenter posts to this app, and Codex's workspace sandbox has no network,
 * so Codex runs with full access, its own name for Claude's bypass.
 */
const MODE = { claude: 'bypassPermissions', codex: 'agent-full-access' } as const;

const table = (page: Page) => page.locator('[data-testid="chat-widget"][data-widget="table"]');

for (const brand of ['claude', 'codex'] as const) {
  for (const paste of [false, true]) {
    test(`${brand}: a presented table is drawn once ${paste ? 'when the agent also pastes it' : 'without a paste'}`, async ({ page, request }) => {
      test.setTimeout(TURN_MS);
      test.skip(process.env.BEADS_E2E_LIVE_PROVIDERS !== '1', 'needs a live provider running a real shell call');
      const name = `${brand}-${paste ? 'pasted' : 'unpasted'}`;
      const path = join(ROOT, name);
      rmSync(path, { recursive: true, force: true });
      mkdirSync(path, { recursive: true });
      let project: Project | undefined;
      try {
        const made = await request.post('/api/projects', { data: { name: `presented-${name}`, path, isTest: true } });
        expect(made.status(), await made.text()).toBe(201);
        project = (await made.json()) as Project;
        const started = await request.post('/api/workbench/command', {
          data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand, permissionMode: MODE[brand] },
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
        await openChat(page, project, sessionId);

        const sent = await request.post('/api/workbench/command', {
          data: { type: 'prompt.send', sessionId, text: ask(paste) },
        });
        expect(sent.ok(), await sent.text()).toBe(true);

        await expect(table(page)).toBeVisible({ timeout: SETTLE_MS });
        await expect(table(page)).toContainText('no paste');
        await expect(page.getByTestId('assistant-message').last()).toContainText('PRESENTED DONE', { timeout: SETTLE_MS });
        await expect(table(page)).toHaveCount(1);
        if (!paste) await expect(page.locator('[data-presented-by]')).toHaveCount(1);
        await page.screenshot({ path: `${SHOTS}/presented-widget-${name}.png` });

        // Read back from the record, it is still one table.
        await page.reload();
        await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
        await expect(table(page)).toHaveCount(1, { timeout: 60_000 });
        await expect(table(page)).toContainText('no paste');
        await page.screenshot({ path: `${SHOTS}/presented-widget-${name}-reloaded.png` });
      } finally {
        if (project) await request.delete(`/api/projects/${project.id}`);
        rmSync(path, { recursive: true, force: true });
      }
    });
  }
}
