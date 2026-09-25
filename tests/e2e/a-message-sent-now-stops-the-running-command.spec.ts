/**
 * A message sent now, while the agent runs a long command, stops the command
 * and is read (bw-fhyi).
 *
 * The manager sent two messages with Ctrl+Enter while the agent ran a
 * five-minute test suite, and the agent never saw either. The app handed each
 * one to the provider mid-turn, and the provider only queued it behind the
 * running command. The chat drew both as sent. Two minutes later the manager
 * pressed Stop, which ends the provider's process, and the queue inside it
 * went with it.
 *
 * What the reader should get: the running turn ends at once, the same agent
 * reads the message as its next prompt, and a message is never shown as sent
 * before the agent has it. A message still waiting when the chat is stopped
 * stays waiting, and can still be sent.
 *
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" \
 *     scripts/workbench-e2e.sh tests/e2e/a-message-sent-now-stops-the-running-command.spec.ts
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-message-sent-now');
const SHOTS = 'tests/results/a-message-sent-now-stops-the-running-command';
const LONG = 'Please run the long command.';
const NOW = 'Stop the tests and say you read this.';
const WAITING = 'When you are done, say you read this too.';

test.skip(
  !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'),
  'needs the scripted ACP agent; see the comment above',
);

test.describe.configure({ mode: 'serial' });

let project: Project | undefined;

test.beforeAll(async ({ request }) => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'message sent now fixture', path: ROOT, isTest: true },
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

/** A chat on screen with the long command running in it; answers the agent's process id. */
async function aChatRunningTheLongCommand(page: Page, request: APIRequestContext): Promise<string> {
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
    data: { type: 'prompt.send', sessionId, text: LONG },
  });
  expect(sent.ok(), await sent.text()).toBe(true);
  const running = page.getByTestId('assistant-message').filter({ hasText: 'Running the tests in agent' });
  await expect(running).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('stop-button')).toBeVisible();
  const said = (await running.textContent()) ?? '';
  const pid = /agent (\d+)/.exec(said)?.[1];
  expect(pid, said).toBeTruthy();
  return pid!;
}

test('a message sent now stops the running command, and the same agent reads it', async ({ page, request }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const pid = await aChatRunningTheLongCommand(page, request);

  const composer = page.getByTestId('composer');
  await composer.fill(NOW);
  await page.screenshot({ path: `${SHOTS}/before-sending-now.png` });
  const pressed = Date.now();
  await composer.press('ControlOrMeta+Enter');

  // Read by the agent that was running the command: the turn was ended, not
  // the agent. The command runs for three minutes, so an answer inside
  // twenty seconds is an answer to the interruption.
  await expect(page.getByTestId('assistant-message').filter({ hasText: `Agent ${pid} read:` }))
    .toHaveCount(1, { timeout: 20_000 });
  expect(Date.now() - pressed).toBeLessThan(20_000);
  await expect(page.getByTestId('user-message').filter({ hasText: NOW })).toHaveCount(1);
  await expect(page.getByTestId('held-message')).toHaveCount(0);
  await expect(page.getByTestId('stop-button')).toHaveCount(0, { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/after-sending-now.png` });
});

test('a message still waiting when the chat is stopped stays waiting, and can still be sent', async ({ page, request }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  await aChatRunningTheLongCommand(page, request);

  const composer = page.getByTestId('composer');
  await composer.fill(WAITING);
  await composer.press('Enter');
  const waiting = page.getByTestId('held-message');
  await expect(waiting).toHaveCount(1);
  await expect(page.getByTestId('user-message').filter({ hasText: WAITING })).toHaveCount(0);

  await page.getByTestId('stop-button').click();
  await expect(page.getByTestId('stop-button')).toHaveCount(0, { timeout: 15_000 });
  // Stop ends the agent's process. The message was never the agent's, so it
  // is still here, still waiting, and not drawn as sent.
  await page.waitForTimeout(2_000);
  await expect(waiting).toHaveCount(1);
  await expect(waiting.getByTestId('held-message-text')).toHaveText(WAITING);
  // And it does not claim to be going: a stopped chat sends nothing by itself.
  await expect(waiting).toContainText('Kept while the chat is stopped');
  await expect(waiting).not.toContainText('Sending now');
  await expect(page.getByTestId('user-message').filter({ hasText: WAITING })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/waiting-after-stop.png` });

  await waiting.getByTestId('held-message-push').click();
  // The agent is started again for it, so its prompt opens with the chat's
  // guidance; the reply echoes all of it.
  await expect(page.getByTestId('assistant-message').filter({ hasText: /read: / }).filter({ hasText: WAITING }))
    .toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('assistant-message').filter({ hasText: 'Running the tests in agent' })).toHaveCount(1);
  await expect(waiting).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/sent-after-stop.png` });
});
