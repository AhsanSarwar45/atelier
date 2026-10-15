import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A shell's tab is drawn only on the screens of the project that opened it
 * (bw-u791v.1).
 *
 * Two real projects, a real shell in each, and the switcher between them: the
 * tabs follow the project on screen, a project with no shells gets no window,
 * and a reload puts every tab back on its own project's screen.
 *
 * Needs an instance built from this worktree, because the shells live in the
 * server: `scripts/workbench-e2e.sh tests/e2e/terminals-belong-to-their-project.spec.ts`.
 */

const SHOTS = 'tests/results';
const FIXTURE = join(__dirname, '..', '.workbench-run-terminal-projects');
const SHELL_MS = 60_000;

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

async function closeEveryShell(request: APIRequestContext): Promise<void> {
  const listed = (await (await request.get('/api/terminal')).json()) as { id: string }[];
  for (const shell of listed) await request.delete(`/api/terminal/${shell.id}`);
}

const tabNames = (page: Page) => page.getByTestId('terminal-tab').allTextContents();

async function openTerminal(page: Page): Promise<void> {
  await page.getByTestId('open-terminal').click();
  await expect(page.getByTestId('terminal-window')).toBeVisible({ timeout: SHELL_MS });
  await expect(page.getByTestId('terminal-tab').first()).toBeVisible({ timeout: SHELL_MS });
}

/** Moves to another project the way a person does, without reloading the page. */
async function switchTo(page: Page, name: string): Promise<void> {
  await page.getByTestId('project-switch').first().click();
  await page.getByTestId('project-switch-row').filter({ hasText: name }).first().click();
  await expect(page.getByTestId('project-name').first()).toHaveText(name);
}

test('each project shows only the terminals opened in it', async ({ page, request }) => {
  test.setTimeout(4 * SHELL_MS);
  rmSync(FIXTURE, { recursive: true, force: true });
  const aspenDir = join(FIXTURE, 'aspen');
  const birchDir = join(FIXTURE, 'birch');
  const cedarDir = join(FIXTURE, 'cedar');
  for (const dir of [aspenDir, birchDir, cedarDir]) mkdirSync(dir, { recursive: true });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await closeEveryShell(request);
  const aspen = await fixtureProject(request, 'aspen', aspenDir);
  const birch = await fixtureProject(request, 'birch', birchDir);
  const cedar = await fixtureProject(request, 'cedar', cedarDir);

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`/project?id=${aspen.id}&tab=chat`);
    await openTerminal(page);
    await page.getByRole('button', { name: 'Open another shell' }).click();
    await expect.poll(() => tabNames(page)).toEqual(['aspen', 'aspen']);
    await page.screenshot({ path: `${SHOTS}/bw-u791v1-aspen.png`, animations: 'disabled' });

    await switchTo(page, 'birch');
    await expect(page.getByTestId('terminal-window'), 'birch has no shells, so no window').toBeHidden();
    await openTerminal(page);
    await expect.poll(() => tabNames(page), { message: 'only birch’s shell' }).toEqual(['birch']);
    await page.screenshot({ path: `${SHOTS}/bw-u791v1-birch.png`, animations: 'disabled' });

    await switchTo(page, 'aspen');
    await openTerminal(page);
    await expect.poll(() => tabNames(page), { message: 'aspen’s shells came back' }).toEqual(['aspen', 'aspen']);

    await switchTo(page, 'cedar');
    await expect(page.getByTestId('terminal-window')).toBeHidden();

    // A reload rebuilds every tab from the server, each on its own project.
    await page.goto(`/project?id=${birch.id}&tab=chat`);
    await openTerminal(page);
    await expect.poll(() => tabNames(page)).toEqual(['birch']);
    await page.goto(`/project?id=${aspen.id}&tab=chat`);
    await openTerminal(page);
    await expect.poll(() => tabNames(page)).toEqual(['aspen', 'aspen']);

    const listed = (await (await request.get('/api/terminal')).json()) as { project: string | null }[];
    expect(listed.map((one) => one.project).sort()).toEqual([aspenDir, aspenDir, birchDir]);
  } finally {
    await closeEveryShell(request);
    for (const made of [aspen, birch, cedar]) await request.delete(`/api/projects/${made.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
