/**
 * A command a real agent ran, drawn as the terminal that ran it when it is
 * OPENED, and work a real chat left behind, settled when that chat goes to
 * sleep (bw-t26l.20, bw-sb5g.3).
 *
 * The conversation itself is not where this lives. A terminal under every
 * command row turned a transcript of a day's work into a wall of black
 * rectangles, and the manager asked for it back the way it was: the shell's
 * own screen is the panel its row opens, and the transcript draws a command
 * the way it draws every other call.
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
      // Still running, and saying so once. The call that backgrounded it
      // returned `exit 0` the instant it was made; that code is the
      // launcher's, and a terminal wearing it under `sleep 300` would
      // contradict the `running` in its own header.
      await expect(pane.getByTestId('ran-terminal-running')).toBeVisible();
      await expect(pane.getByTestId('ran-terminal-exit')).toHaveCount(0);
      // `animations: 'disabled'` because the pane fades in over the chat, and a
      // shot taken through it shows the transcript behind the terminal.
      await pane.screenshot({ path: `${SHOTS}/a-shell-is-a-terminal-pane.png`, animations: 'disabled' });
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
      // Nothing is left in the working list. This is the manager's own screen
      // in one attribute: eight rows reading "Working" for fifteen hours were
      // eight rows this count never came down for.
      const panel = page.getByTestId('sent-away-panel');
      await expect(panel).toHaveAttribute('data-running', '0');
      await panel.getByTestId('toggle-stopped-agents').click();
      await expect(row).toBeVisible();
      await panel.screenshot({ path: `${SHOTS}/a-shell-is-a-terminal-settled.png` });

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
