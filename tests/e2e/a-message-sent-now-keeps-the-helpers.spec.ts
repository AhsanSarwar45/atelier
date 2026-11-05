/**
 * A message sent now stops the main agent, and the helpers it sent away keep
 * running (bw-pnhyd.1).
 *
 * Sending now ended the turn with the protocol's cancel, and in Claude that
 * cancel stops every task the session started. The manager: "when i send a
 * message in a runing chat, the subagents stop". What the reader should get:
 * the main agent's running command is stopped and it reads the message at once,
 * while a helper it sent away carries on and finishes its work.
 *
 * Live, because what stops and what keeps running is the real CLI's doing.
 *
 *   BEADS_E2E_LIVE_PROVIDERS=1 BEADS_E2E_ACP_ADAPTERS=<bundle with stop-main> \
 *     scripts/workbench-e2e.sh tests/e2e/a-message-sent-now-keeps-the-helpers.spec.ts
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-keep-helpers');
const SHOTS = 'tests/results/a-message-sent-now-keeps-the-helpers';
const marker = (name: string) => join(ROOT, name);
const ASKED = [
  'Do exactly this, with no commentary.',
  '1) Use the Agent tool with run_in_background: true and subagent_type general-purpose, with this prompt:',
  `"Run this one Bash command in the foreground, without run_in_background, and nothing else: touch ${marker('helper-started')} && python3 -c 'import time; time.sleep(60)' && touch ${marker('helper-done')}"`,
  `2) Right after launching it, run this Bash command in the foreground with a timeout of 600000: touch ${marker('main-started')} && python3 -c 'import time; time.sleep(400)'`,
].join('\n');
const NOW = 'Reply with only the word PONG. Do not run any tools.';

test.skip(
  process.env.BEADS_E2E_LIVE_PROVIDERS !== '1',
  'needs a live provider: only the real CLI decides what an interruption stops',
);

test.describe.configure({ mode: 'serial', timeout: 420_000 });

let project: Project | undefined;

test.beforeAll(async ({ request }) => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'keep helpers fixture', path: ROOT, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  project = (await made.json()) as Project;
});

test.afterAll(async ({ request }) => {
  if (project) await request.delete(`/api/projects/${project.id}`, { timeout: 10_000 }).catch(() => undefined);
  rmSync(ROOT, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
});

async function until(what: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !what()) await new Promise((resolve) => setTimeout(resolve, 250));
  return what();
}

test('a message sent now is answered at once, and the helper finishes its work', async ({ page, request }) => {
  mkdirSync(SHOTS, { recursive: true });
  const started = await request.post('/api/workbench/command', {
    data: {
      type: 'session.start',
      projectId: project!.id,
      projectPath: project!.path,
      brand: 'claude',
      permissionMode: 'bypassPermissions',
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const sessionId = ((await started.json()) as { id: string }).id;

  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto(`/project?id=${project!.id}&tab=chat&chat=${sessionId}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
  const sent = await request.post('/api/workbench/command', {
    data: { type: 'prompt.send', sessionId, text: ASKED },
  });
  expect(sent.ok(), await sent.text()).toBe(true);

  // Both running: the helper on its minute, the main agent on its long command.
  expect(await until(() => existsSync(marker('helper-started')) && existsSync(marker('main-started')), 180_000),
    'the helper and the main agent both started their commands').toBe(true);
  await page.waitForTimeout(3_000);
  await expect(page.getByTestId('stop-button')).toBeVisible();
  expect(existsSync(marker('helper-done'))).toBe(false);

  const composer = page.getByTestId('composer');
  await composer.fill(NOW);
  await page.screenshot({ path: `${SHOTS}/before-sending-now.png` });
  const pressed = Date.now();
  await composer.press('ControlOrMeta+Enter');

  // The main command runs for over six minutes, so an answer inside a minute
  // is an answer to the message sent now.
  await expect(page.getByTestId('assistant-message').filter({ hasText: 'PONG' }))
    .toHaveCount(1, { timeout: 60_000 });
  const answeredIn = Date.now() - pressed;
  expect(answeredIn).toBeLessThan(60_000);
  // The helper was still mid-way when the answer came.
  expect(existsSync(marker('helper-done')), 'the answer came before the helper was done').toBe(false);
  await page.screenshot({ path: `${SHOTS}/answered-with-the-helper-running.png` });

  // And the helper was not stopped with the main agent: it finishes its minute.
  expect(await until(() => existsSync(marker('helper-done')), 120_000),
    'the helper kept running and finished its work').toBe(true);
  await page.waitForTimeout(5_000);
  await page.screenshot({ path: `${SHOTS}/the-helper-finished.png` });
  console.log(`answered ${answeredIn} ms after the key press; the helper finished`);
});
