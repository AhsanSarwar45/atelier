import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { askingSpec, OPEN_CARD, makeFixtureProject } from './fixture-board';

/**
 * Saying a report is waiting on you (bw-7ks.21.6).
 *
 * A report that ends in a question is work stopped until it is answered, and
 * the app said nothing about it: a page handed over on Monday sat unread until
 * somebody remembered the link. So the count is on the list of projects and on
 * the project's own Reports tab.
 *
 * What makes it true is the board, not the report: the question names the card
 * it is holding up, so this run closes that card and expects the count to go
 * with it — the same rule the report builder refuses a dead question by.
 *
 * The project is built for the run: its own git repo, its own beads database,
 * its own report. Needs an instance built from this worktree.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3028 npx playwright test tests/e2e/report-waiting.spec.ts
 */

/** The folder a report is filed under is the project folder's own name. */
const PROJECT_NAME = 'waitingdemo';
const SLUG = 'a-question-for-you';
const RUN_DIR = join(__dirname, '..', '.report-waiting-run');
const PROJECT_DIR = join(RUN_DIR, PROJECT_NAME);

/** Where the instance under test keeps its report specs. */
function reportsHome(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(data, 'kanban-ui', 'reports', PROJECT_NAME);
}

async function projectAt(request: APIRequestContext, path: string): Promise<{ id: string }> {
  const existing = (await (await request.get('/api/projects')).json()) as { id: string; path: string }[];
  const found = existing.find((p) => p.path === path);
  if (found) return found;
  const created = await request.post('/api/projects', { data: { name: PROJECT_NAME, path } });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json()) as { id: string };
}

/**
 * The fixture's own card on the list of projects.
 *
 * The instance under test shares this computer's project list, so the run must
 * find its own project among the real ones rather than the only one there.
 */
function ourCard(page: Page) {
  return page.locator('[role="link"]').filter({ hasText: PROJECT_DIR });
}

test.describe('a report waiting on an answer', () => {
  test('is counted for the project until the card its question holds up closes', async ({ page, request }) => {
    test.setTimeout(240_000);

    rmSync(RUN_DIR, { recursive: true, force: true });
    rmSync(reportsHome(), { recursive: true, force: true });
    mkdirSync(RUN_DIR, { recursive: true });
    makeFixtureProject(PROJECT_DIR, join(RUN_DIR, 'reporting'), {
      spec: askingSpec(OPEN_CARD),
      specPath: join(reportsHome(), `${SLUG}.report.json`),
    });

    const project = await projectAt(request, PROJECT_DIR);

    try {
      // ---- the list of projects says so ----------------------------------
      await page.goto('/');
      await expect(ourCard(page)).toBeVisible({ timeout: 60_000 });
      await expect(ourCard(page).getByTestId('project-reports-waiting')).toHaveText('1 report waiting', {
        timeout: 60_000,
      });

      // ---- and so does the project itself --------------------------------
      await page.goto(`/project?id=${project.id}&tab=reports`);
      await expect(page.getByTestId('tab-reports-waiting')).toHaveText('1', { timeout: 60_000 });
      const row = page.locator('[data-testid="reports-list-item"]').filter({ hasText: SLUG });
      await expect(row.getByTestId('reports-list-waiting')).toBeVisible({ timeout: 60_000 });

      // ---- the board settles it, and the count goes ------------------------
      execFileSync('bd', ['close', OPEN_CARD, '--reason', 'answered elsewhere'], {
        cwd: PROJECT_DIR,
        stdio: 'pipe',
        timeout: 60_000,
      });
      // The server holds its answer for a moment so a board full of cards costs
      // one board read between them (`MEMO` in routes/reports.rs).
      await page.waitForTimeout(4_000);

      await page.goto(`/project?id=${project.id}&tab=reports`);
      await expect(page.getByTestId('reports-list-item').first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('tab-reports-waiting')).toHaveCount(0);
      await expect(page.getByTestId('reports-list-waiting')).toHaveCount(0);

      await page.goto('/');
      await expect(ourCard(page)).toBeVisible({ timeout: 60_000 });
      await expect(ourCard(page).getByTestId('project-reports-waiting')).toHaveCount(0);
    } finally {
      await request.delete(`/api/projects/${project.id}`);
      rmSync(reportsHome(), { recursive: true, force: true });
      rmSync(RUN_DIR, { recursive: true, force: true });
    }
  });
});
