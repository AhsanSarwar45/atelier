import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * A bare folder gets the same bar its chat's own tools are drawn in.
 *
 * The second bar carries two things at once: the tab selector, and the slots
 * every tab fills with its own controls. A project that is only a folder once
 * lost the whole bar, and with it the chat's filter and its branch drawer
 * (bw-1wak). Every project now has its tabs, so the bar is always there.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-only-keeps-the-tools-bar.spec.ts
 */

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** A folder of its own: a bare directory with nothing set up in it. */
const FIXTURE = join(__dirname, '..', '.workbench-run-chat-only');

/** The project list arrives over the network before the name can be read. */
const OPEN_MS = 30_000;

/**
 * Added like any other project, not marked as a fixture: the screen reads the
 * project out of the list the dashboard reads, and that list leaves marked
 * projects out — so a marked one opens on "project not found" and never gets
 * as far as the bar. It is removed again at the end instead.
 */
async function chatOnlyProject(request: APIRequestContext): Promise<string> {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'chat-only', path: FIXTURE },
  });
  expect(made.status(), await made.text()).toBe(201);
  const { id } = (await made.json()) as { id: string };
  return id;
}

test.describe('a project that is only a folder', () => {
  test('keeps the tabs and the tools bar', async ({ page, request }) => {
    const id = await chatOnlyProject(request);
    try {
      await page.goto(`/project?id=${id}&tab=chat`);

      await expect(page.getByTestId('project-name')).toHaveText('chat-only', { timeout: OPEN_MS });

      await expect(page.getByTestId('project-tabs'), 'every project has its tabs').toBeVisible();
      const bar = page.getByTestId('tab-bar');
      await expect(bar, 'the chat has its own tools and nowhere else to draw them').toBeVisible();
      await expect(page.getByTestId('tab-lead')).toBeAttached();
      await expect(page.getByTestId('tab-tools')).toBeAttached();
      await expect(page.getByTestId('tab-trail')).toBeAttached();

      // The controls themselves, not just the slots that hold them.
      await expect(
        bar.getByRole('button'),
        'the filter, the branch drawer and the rest are back on the bar',
      ).not.toHaveCount(0);

      const room = await page.getByTestId('shell').boundingBox();
      expect(room).not.toBeNull();
      await page.screenshot({
        path: `${SHOTS}/bw-1wak-chat-only-bar.png`,
        clip: { x: 0, y: 0, width: room!.width, height: 120 },
      });
    } finally {
      await request.delete(`/api/projects/${id}`);
      rmSync(FIXTURE, { recursive: true, force: true });
    }
  });
});
