import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { ASK, askingSpec, OPEN_CARD, PARENT_CARD, SAY_BACK, makeFixtureProject } from './fixture-board';

/**
 * Answering a report from the report (bw-7ks.21.5).
 *
 * The complaint behind it: a report ends in a question, and the answer left the
 * page as text on the clipboard — to be pasted onto the card, or into the chat,
 * or nowhere at all while the work waited on an answer that had been given.
 *
 * So this run gives an answer the way the manager does — clicking a chip and
 * confirming — and then goes looking for it in the two places it must land: the
 * board's own comments on the card the question holds up, and the transcript of
 * the chat that worked on it.
 *
 * Nothing here touches a live board. The project is built for the run: its own
 * git repo, its own beads database, its own report, and a chat started in it.
 * The card-to-chat link is written the way the sidecar writes it, with
 * `bd provenance record`, so the app reads the join it always reads.
 *
 * Needs an instance built from this worktree and the terminal's own Claude
 * sign-in (a chat is started, and answering it wakes a real agent).
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3028 npx playwright test tests/e2e/report-answer.spec.ts
 */

/** The folder a report is filed under is the project folder's own name. */
const PROJECT_NAME = 'answerdemo';
const SLUG = 'a-question-for-you';
const RUN_DIR = join(__dirname, '..', '.report-answer-run');
const PROJECT_DIR = join(RUN_DIR, PROJECT_NAME);

/** Where the instance under test keeps its report specs and built pages. */
function reportsHome(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(data, 'kanban-ui', 'reports', PROJECT_NAME);
}

/**
 * A fixture project, made or reused, and marked `isTest` so it stays off the
 * owner's real dashboard and gets swept up by teardown rather than living on
 * his machine like the seven that got left behind before this ran through a
 * script that isolates its own settings DB.
 */
async function projectAt(request: APIRequestContext, path: string): Promise<{ id: string }> {
  const existing = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const found = existing.find((p) => p.path === path);
  if (found) return found;
  const created = await request.post('/api/projects', { data: { name: PROJECT_NAME, path, isTest: true } });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json()) as { id: string };
}

/** What the board itself holds against a card, in its own words. */
async function commentsOn(request: APIRequestContext, card: string): Promise<string> {
  const res = await request.post('/api/bd/command', { data: { args: ['comments', card], cwd: PROJECT_DIR } });
  expect(res.status(), await res.text()).toBe(200);
  const out = (await res.json()) as { stdout: string; stderr: string; code: number };
  return `${out.stdout}\n${out.stderr}`;
}

test.describe('answering a report', () => {
  /**
   * `useProject` resolves a project by filtering the plain project list
   * client-side (`src/hooks/use-project.ts`) — there is no per-ID lookup on
   * the server. A fixture project is marked `isTest` so a plain
   * `GET /api/projects` leaves it off the owner's real dashboard (bw-6m6w.9),
   * but that same filtering would make it invisible to its OWN browser tab
   * too: the project page would never resolve a name and the report/chat
   * screens would never mount. So every request this page makes for the
   * plain list is asked for test projects as well — a rewrite scoped to this
   * page alone, so a real visitor typing the same URL still sees none of them.
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('a picked answer lands on the card and in the chat that worked it', async ({ page, request }) => {
    // A real chat is started and woken, so this is a live-agent test.
    test.setTimeout(600_000);

    rmSync(RUN_DIR, { recursive: true, force: true });
    rmSync(reportsHome(), { recursive: true, force: true });
    mkdirSync(RUN_DIR, { recursive: true });
    makeFixtureProject(PROJECT_DIR, join(RUN_DIR, 'reporting'), {
      spec: askingSpec(OPEN_CARD),
      specPath: join(reportsHome(), `${SLUG}.report.json`),
    });

    const project = await projectAt(request, PROJECT_DIR);

    // A chat in this project, and the board's own record that it worked the
    // card — written the way the sidecar writes it (workbench/src/bd.ts).
    const started = await request.post('/api/workbench/command', {
      data: {
        type: 'session.start',
        projectId: project.id,
        projectPath: PROJECT_DIR,
        brand: 'claude',
        permissionMode: 'bypassPermissions',
      },
    });
    expect(started.status(), await started.text()).toBe(200);
    const session = (await started.json()) as { id: string };

    for (const card of [PARENT_CARD, OPEN_CARD]) {
      execFileSync(
        'bd',
        ['provenance', 'record', '--issue', card, '--kind', 'used', '--source', 'report-answer-test', '--ref', session.id, '--ref-kind', 'transcript'],
        { cwd: PROJECT_DIR, stdio: 'pipe', timeout: 60_000 },
      );
    }

    try {
      // ---- the answer, given the way he gives it -------------------------
      await page.goto(`/project?id=${project.id}&tab=reports&report=${SLUG}`);

      const question = page.locator('[role="radiogroup"]').first();
      await expect(question).toBeVisible({ timeout: 120_000 });
      // The second option, not the one that starts picked: the click has to be
      // what decides the answer, not the report's own default.
      await question.getByRole('radio').nth(1).click();

      await page.getByTestId('report-answer-send').click();

      // ---- where it is going, named before it goes ------------------------
      await expect(page.locator(`[data-testid="report-answer-target-card"][data-card-id="${OPEN_CARD}"]`)).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.locator(`[data-testid="report-answer-target-chat"][data-session-id="${session.id}"]`),
      ).toBeVisible({ timeout: 60_000 });

      // Nothing has been written yet — the board still holds no answer.
      expect(await commentsOn(request, OPEN_CARD)).not.toContain(SAY_BACK);

      await page.getByTestId('report-answer-confirm-send').click();
      await expect(page.getByTestId('report-answer-result')).toContainText('Written on the card', { timeout: 120_000 });

      // ---- (a) the board's own copy ---------------------------------------
      const onCard = await commentsOn(request, OPEN_CARD);
      expect(onCard, 'the comment quotes the question').toContain(ASK);
      expect(onCard, 'the comment carries the answer he picked').toContain(SAY_BACK);

      // ---- (b) the chat that worked it ------------------------------------
      await page.goto(`/project?id=${project.id}&chat=${session.id}&tab=chat`);
      await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 120_000 });
      const said = page.getByTestId('user-message').filter({ hasText: ASK });
      await expect(said.first()).toBeVisible({ timeout: 120_000 });
      await expect(said.first()).toContainText(SAY_BACK);
    } finally {
      await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: session.id } });
      await request.delete(`/api/projects/${project.id}`);
      rmSync(reportsHome(), { recursive: true, force: true });
      rmSync(RUN_DIR, { recursive: true, force: true });
    }
  });
});
