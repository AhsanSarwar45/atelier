/**
 * A command a real agent ran, drawn as the terminal that ran it, and work a
 * real chat left behind, settled when that chat goes to sleep (bw-t26l.20).
 *
 * Against a live provider, because both promises are about what a provider
 * actually sends. The exit code on the row is one this side never invented:
 * either it came from a terminal this app opened for the agent, or the agent
 * sent it beside the tool call because this client said it could read one.
 * Neither happens against a fixture.
 *
 * The screenshots are the point as much as the assertions. "The UI for the
 * shell has a chat in it" was said about a screen, and a green assertion about
 * a test id would not have answered it.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-shell-terminal');
const SHOTS = 'tests/results';
const TURN_MS = 600_000;
const SETTLE_MS = 60_000;

async function createProject(request: APIRequestContext, name: string): Promise<Project> {
  const path = join(ROOT, name);
  mkdirSync(path, { recursive: true });
  const response = await request.post('/api/projects', { data: { name: `shell-terminal-${name}`, path, isTest: true } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Project;
}

async function startSession(request: APIRequestContext, project: Project): Promise<string> {
  const response = await request.post('/api/workbench/command', {
    data: {
      type: 'session.start',
      projectId: project.id,
      projectPath: project.path,
      brand: 'claude',
      permissionMode: 'bypassPermissions',
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

async function say(request: APIRequestContext, sessionId: string, text: string): Promise<void> {
  const sent = await request.post('/api/workbench/command', { data: { type: 'prompt.send', sessionId, text } });
  expect(sent.ok(), await sent.text()).toBe(true);
}

test.describe('a shell is a terminal', () => {
  test.describe.configure({ mode: 'serial', timeout: TURN_MS });

  test.beforeAll(() => {
    expect(process.env.BEADS_E2E_LIVE_PROVIDERS, 'set BEADS_E2E_LIVE_PROVIDERS=1').toBe('1');
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('a command in the transcript is drawn with its output and its exit code', async ({ page, request }) => {
    let project: Project | undefined;
    try {
      project = await createProject(request, 'inline');
      const sessionId = await startSession(request, project);
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });

      // A command that paints and then fails. Both halves matter: the escapes
      // prove the output reached a terminal parser rather than a paragraph,
      // and the code proves the row can say how a command ended.
      await say(
        request,
        sessionId,
        'Run exactly one Bash command, verbatim: printf \'\\033[31mFAIL\\033[0m one case\\n\'; exit 3\n' +
          'It is supposed to fail. Do not try to fix it, do not run any other command, and do not read any file. ' +
          'Then reply exactly SHELL DONE.',
      );
      await expect(page.getByTestId('assistant-message').last()).toContainText('SHELL DONE', { timeout: SETTLE_MS });

      const terminal = page.getByTestId('ran-terminal').first();
      await expect(terminal).toBeVisible({ timeout: SETTLE_MS });
      await expect(terminal.getByTestId('ran-terminal-command')).toContainText('printf');
      // A number, and a failing one. Not `exit 3` exactly: the code on the row
      // is the one the PROVIDER reported for the call, and Claude's shell
      // wrapper reports its own (it answered 1 for this command on 2026-09-04,
      // while printing `Exit code 3` in the output). Which number it reports
      // is its business; that a number reaches the row at all is this app's,
      // and before this none ever did.
      await expect(terminal.getByTestId('ran-terminal-exit')).toHaveText(/exit [1-9][0-9]*/);
      // The escapes were parsed rather than printed: the grid holds the word
      // and not the `[31m` in front of it.
      await expect(terminal.getByTestId('ran-terminal-grid')).toContainText('FAIL');
      await expect(terminal.getByTestId('ran-terminal-grid')).not.toContainText('[31m');

      await terminal.screenshot({ path: `${SHOTS}/a-shell-is-a-terminal-row.png` });

      // And it is still a terminal after a reload: it is read from the record,
      // not held in a browser that happened to watch it run.
      await page.reload();
      await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
      const back = page.getByTestId('ran-terminal').first();
      await expect(back.getByTestId('ran-terminal-exit')).toHaveText(/exit [1-9][0-9]*/, { timeout: SETTLE_MS });
      await expect(back.getByTestId('ran-terminal-grid')).toContainText('FAIL');
    } finally {
      if (project) await request.delete(`/api/projects/${project.id}`);
    }
  });

  test('a background command opens as a terminal, and stops when its chat sleeps', async ({ page, request }) => {
    let project: Project | undefined;
    try {
      project = await createProject(request, 'background');
      const sessionId = await startSession(request, project);
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });

      await say(
        request,
        sessionId,
        'Use the Bash tool exactly once with run_in_background=true to run: sleep 300\n' +
          'Do not wait for it, do not check on it, and do not run any other command. ' +
          'As soon as the tool returns, reply exactly BACKGROUND RUNNING.',
      );
      await expect(page.getByTestId('assistant-message').last()).toContainText('BACKGROUND RUNNING', {
        timeout: SETTLE_MS,
      });

      const row = page.locator('[data-testid="sent-away-row"][data-kind="command"]').first();
      await expect(row).toBeVisible({ timeout: SETTLE_MS });
      await row.click();

      // The pane a command opens: a terminal with the command on it, and none
      // of the conversation furniture a command has never had a use for.
      const pane = page.getByTestId('agent-view');
      await expect(pane.getByTestId('agent-view-shell')).toBeVisible();
      await expect(pane.getByTestId('ran-terminal-command')).toContainText('sleep 300');
      await expect(pane.getByTestId('agent-view-said')).toHaveCount(0);
      await expect(pane.getByTestId('agent-view-relay')).toHaveCount(0);
      await pane.screenshot({ path: `${SHOTS}/a-shell-is-a-terminal-pane.png` });
      await page.getByTestId('agent-view-close').click();

      // The row is working, and nothing in the chat will ever say otherwise:
      // the command outlives the turn on purpose, and `sleep 300` will not be
      // reported to anybody.
      await expect(row).toHaveAttribute('data-state', 'running');

      // Until the chat goes to sleep. Then the row settles, because the last
      // thing that could have reported it has gone.
      const closed = await request.post('/api/workbench/command', { data: { type: 'session.close', sessionId } });
      expect(closed.ok(), await closed.text()).toBe(true);
      await expect(row).toHaveAttribute('data-state', 'stopped', { timeout: SETTLE_MS });
      await page.getByTestId('sent-away-panel').screenshot({
        path: `${SHOTS}/a-shell-is-a-terminal-settled.png`,
      });

      // And it stays settled when the chat is read back from the record, which
      // is where the fifteen-hour rows on the manager's own board came from.
      await page.reload();
      await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
      await expect(page.locator('[data-testid="sent-away-row"][data-kind="command"]').first()).toHaveAttribute(
        'data-state',
        'stopped',
        { timeout: SETTLE_MS },
      );
    } finally {
      if (project) await request.delete(`/api/projects/${project.id}`);
    }
  });
});
