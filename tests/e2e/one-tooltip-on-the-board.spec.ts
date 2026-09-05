import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * The board's screens say what they have to say through the app's own label
 * too, not the browser's (bw-6wq6.3).
 *
 * A project's folder is the case worth proving: the line under the name is
 * trimmed to the width of the card, so on anything narrow the path a reader
 * came for is exactly the part that is missing, and the hover is how it is
 * read. It used to be a `title` — the browser's yellow box, after the
 * browser's own wait.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/one-tooltip-on-the-board.spec.ts
 */

const FIXTURE = join(__dirname, '..', '.workbench-run-board-tooltip');

test('a project card says where the project is through the app’s one tooltip', async ({ page, request }) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  const made = await request.post('/api/projects', { data: { name: 'board-tooltip', path: FIXTURE } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  try {
    await page.goto('/');
    const path = page.getByTestId('project-path').filter({ hasText: FIXTURE }).first();
    await expect(path).toBeVisible({ timeout: 30_000 });
    // Nothing for the browser to draw: the label is the app's now.
    await expect(path).not.toHaveAttribute('title', /./);

    await path.hover();
    await expect(page.getByRole('tooltip')).toContainText(FIXTURE);
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'tests/results/bw-6wq6-board-hover.png', animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
