import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const FIXTURE = join(__dirname, '..', '.workbench-run-one-tooltip');

/**
 * Every hover label in the app is drawn by one component now, so the app's
 * plainest one — a toolbar button — is where the face it draws is read off a
 * running screen (bw-6wq6.1). The labels that carry more than a sentence are
 * covered beside their own screens: the chooser's in
 * `new-chat-unavailable-hover.spec.ts`, the donut's breakdown in
 * `src/components/__tests__/status-donut.test.tsx`.
 */
test("a toolbar button answers a hover with the app's own label", async ({ page, request }) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  const made = await request.post('/api/projects', { data: { name: 'one-tooltip', path: FIXTURE } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  try {
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const search = page.getByTestId('open-search');
    await expect(search).toBeVisible();
    await search.hover();
    const label = page.getByRole('tooltip');
    await expect(label).toContainText('Search chats');
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'tests/results/bw-6wq6-toolbutton.png', clip: { x: 0, y: 0, width: 900, height: 300 }, animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
