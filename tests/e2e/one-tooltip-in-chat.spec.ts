import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { PARENT_CARD, discardFixture, makeFixtureProject } from './fixture-board';
import { writeChatWithHelper } from './fixture-record';

/**
 * The hover labels on a chat are the app's own, not the browser's (bw-6wq6.2).
 *
 * The folder chip above a conversation used to carry a `title`: a label the
 * browser drew, after a wait it chose, in the plain yellow box of the desktop
 * rather than in anything belonging to this app. That chip is the one proved
 * here because it is reachable without starting an agent — the chat is read
 * back off a written record — and because what it says, the whole path and the
 * branch, is exactly the sort of thing worth hovering for.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/one-tooltip-in-chat.spec.ts
 */

/** A folder of its own, so this case never reads somebody's real chats. */
const RUN = join(__dirname, '..', '.workbench-run-one-tooltip');
const PROJECT = join(RUN, 'project');

/** Opening a chat off the disk still waits on the list arriving. */
const OPEN_MS = 60_000;

async function projectAt(request: APIRequestContext, name: string, path: string): Promise<{ id: string }> {
  const made = await request.post('/api/projects', { data: { name, path } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

// Reading a chat back off the disk is a page load, a list and a transcript.
test.setTimeout(120_000);

test('a chat draws its hover labels with the app’s one tooltip', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  discardFixture(RUN);
  mkdirSync(RUN, { recursive: true });
  makeFixtureProject(PROJECT, join(RUN, 'reports'));
  const project = await projectAt(request, 'workbench-one-tooltip', PROJECT);
  const written = writeChatWithHelper({ cwd: PROJECT, sessionId: randomUUID(), card: PARENT_CARD });

  try {
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
    await row.waitFor({ timeout: OPEN_MS });
    await row.getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: OPEN_MS });

    const chip = page.getByTestId('chat-folder-chip');
    await expect(chip).toBeVisible({ timeout: OPEN_MS });
    // Nothing for the browser to draw: the label is the app's now.
    await expect(chip).not.toHaveAttribute('title', /./);

    await chip.hover();
    const label = page.getByRole('tooltip');
    await expect(label).toContainText(PROJECT);
    // It settles under the chip before the shot: a label caught mid-fade is
    // half there, which proves nothing about how it reads.
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'tests/results/bw-6wq6-chat-hover.png', animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    discardFixture(RUN);
  }
});
