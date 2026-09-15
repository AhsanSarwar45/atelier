/**
 * A message sent while the agent is waiting on a question moves the chat on
 * (bw-1duw.1).
 *
 * The manager left a question card unanswered and typed an ordinary message
 * instead: "this chat completely broke … i can't send a message. i can't click
 * the stop button. nothing." The question's answer was awaited inside the
 * connection's own reading loop, so the steered message waited for a reply
 * that loop could never read, and every command after it — Stop included —
 * queued behind that one.
 *
 * What the reader should get is what the agent's own terminal gives: the
 * question is closed as not answered, the message reaches the agent, and Stop
 * stops.
 *
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" \
 *     scripts/workbench-e2e.sh tests/e2e/a-message-sent-past-a-question-moves-the-chat-on.spec.ts
 *
 * THE_CHAT_STICKS=1 takes the picture of the build before the fix.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-message-past-question');
const SHOTS = 'tests/results';
const HEADER = 'Direction';
const INSTEAD = 'Never mind, read it from the environment.';
const STICKS = Boolean(process.env.THE_CHAT_STICKS);

test('a message sent instead of an answer closes the question, reaches the agent, and Stop still stops', async ({ page, request }) => {
  test.setTimeout(240_000);
  test.skip(
    !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'),
    'needs the scripted ACP agent; see the comment above',
  );
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  let project: Project | undefined;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'message past a question fixture', path: ROOT, isTest: true },
    });
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

    await page.setViewportSize({ width: 1100, height: 760 });
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });

    const sent = await request.post('/api/workbench/command', {
      data: { type: 'prompt.send', sessionId, text: 'Ask me which direction to take.' },
    });
    expect(sent.ok(), await sent.text()).toBe(true);

    const cards = page.getByTestId('question-card');
    const card = cards.first();
    await expect(card).toHaveAttribute('data-question-state', 'open', { timeout: 60_000 });
    await expect(card).toContainText(HEADER);
    const line = page.getByTestId('working-line');
    await expect(line).toHaveAttribute('data-waiting', 'true');

    // Not answered: the reader types something else and sends it.
    const composer = page.getByTestId('composer');
    await composer.fill(INSTEAD);
    await composer.press('Enter');
    const instead = page.getByTestId('user-message').filter({ hasText: INSTEAD });

    if (STICKS) {
      // The build before the fix: the card stays open, the line keeps
      // waiting, and Stop is pressed to no effect.
      await page.waitForTimeout(5_000);
      await expect(card).toHaveAttribute('data-question-state', 'open');
      await expect(line).toHaveAttribute('data-waiting', 'true');
      await page.getByTestId('stop-button').click();
      await page.waitForTimeout(5_000);
      await expect(line).toHaveAttribute('data-waiting', 'true');
      await page.screenshot({ path: `${SHOTS}/a-message-past-a-question-sticks.png` });
      return;
    }

    // The question is closed as not answered, and nothing is waiting on the
    // reader any more.
    await expect(card).toHaveAttribute('data-question-state', 'resolved', { timeout: 15_000 });
    await expect(card).toContainText('Not answered');
    await expect(line).toHaveAttribute('data-waiting', 'false', { timeout: 15_000 });
    await expect(instead).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/a-message-past-a-question-moves-on.png` });

    // The message reached the agent, which reads it out once its turn ends.
    await expect(page.getByTestId('assistant-message').filter({ hasText: `read ${INSTEAD}` }))
      .toHaveCount(1, { timeout: 90_000 });
    await expect(page.getByTestId('stop-button')).toHaveCount(0, { timeout: 30_000 });

    // Asked again, answered again with a message, and stopped straight after:
    // Stop is not queued behind the message.
    const again = await request.post('/api/workbench/command', {
      data: { type: 'prompt.send', sessionId, text: 'Ask me again.' },
    });
    expect(again.ok(), await again.text()).toBe(true);
    const second = cards.nth(1);
    await expect(second).toHaveAttribute('data-question-state', 'open', { timeout: 60_000 });
    await composer.fill('Stop there.');
    await composer.press('Enter');
    await expect(second).toHaveAttribute('data-question-state', 'resolved', { timeout: 15_000 });
    await page.getByTestId('stop-button').click();
    await expect(page.getByTestId('stop-button')).toHaveCount(0, { timeout: 15_000 });
    await expect(line).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/a-message-past-a-question-stops.png` });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`, { timeout: 10_000 }).catch(() => undefined);
    rmSync(ROOT, { recursive: true, force: true });
  }
});
