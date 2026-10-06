import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { CHAT_SAID, writeChatWithHelper } from './fixture-record';
import { restartInstance } from './restart';

/**
 * A previous Claude chat, opened again, offers every model and effort its
 * provider does — before anything is sent to it.
 *
 * Opening a saved chat reads its Claude record into the app, and that reading
 * wrote a menu of its own naming no models and no efforts. The menu replaced
 * the one the chat would otherwise have been shown, and it was also kept as
 * what the provider offers on that account and project, so every stopped chat
 * there lost both lists. The composer then drew only "Default" and the chat's
 * own model, and no effort picker at all (bw-2m8so.1).
 *
 * The record is one the kit writes for a chat that sent a helper away, which
 * is the record this app always reads itself rather than asking the agent to
 * replay — the path every such chat takes when it is reopened.
 *
 * Serial with anything else on the stack: it restarts the server.
 *
 * Run: PINNED_ACP_FIXTURE=1 \
 *      PINNED_ACP_MODELS="default,claude-opus-5,claude-sonnet-5,claude-haiku-5" \
 *      ATELIER_ACP_CLAUDE_PATH="$PWD/tests/fixtures/acp-adapters/pinned-acp" \
 *      CLAUDE_PATH="$PWD/tests/fixtures/acp-adapters/claude" \
 *      PINNED_ACP_WIRE="$WORKBENCH_E2E_RUN/pinned-acp-wire.jsonl" \
 *      scripts/workbench-e2e.sh tests/e2e/reopened-chat-offers-every-control.spec.ts
 *
 * REOPENED_SHOT=<path>.png photographs the open model menu, and the effort
 * menu beside it as <path>-effort.png.
 */

/** Starting an agent and hearing back what it can do is a process launch. */
const HELLO_MS = 120_000;

/** A folder of its own, so no agent runs in anybody's work. */
const FIXTURE = join(__dirname, '..', '.workbench-run-reopened-controls');

/** What the fixture agent offers, beyond the one model the saved chat is on. */
const MODELS = (process.env.PINNED_ACP_MODELS ?? '').split(',').filter(Boolean);
const EFFORTS = ['low', 'medium', 'high'];

interface Project {
  id: string;
  path: string;
}

async function fixtureProject(request: APIRequestContext): Promise<Project> {
  const made = await request.post('/api/projects', {
    data: { name: 'reopened-controls', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as Project;
}

/** Everything the fixture agent was asked, in order. */
function wire(): { method: string }[] {
  const path = process.env.PINNED_ACP_WIRE;
  if (!path) return [];
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** What a picker offers, read by opening it and shut again afterwards. */
async function offered(page: Page, picker: string): Promise<string[]> {
  const button = page.getByTestId('desktop-composer-settings').getByTestId(picker);
  if (!(await button.isVisible())) return [];
  await button.click();
  const options = page.getByTestId(`${picker}-option`);
  await options.first().waitFor({ timeout: 5_000 }).catch(() => {});
  const values = await options.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.value ?? ''));
  await shut(page, picker);
  return values;
}

/** Closes a picker's menu and waits until it is gone, so the next click lands. */
async function shut(page: Page, picker: string): Promise<void> {
  const menu = page.getByTestId(`${picker}-menu`);
  await expect.poll(async () => {
    if (await menu.count()) await page.keyboard.press('Escape');
    return menu.count();
  }, { timeout: 10_000 }).toBe(0);
}

/** Opens a picker and photographs the screen once its menu has settled. */
async function photograph(page: Page, picker: string, path: string): Promise<void> {
  await page.getByTestId('desktop-composer-settings').getByTestId(picker).click();
  await page.getByTestId(`${picker}-menu`).waitFor();
  // The menu fades in; a picture taken at once is of a ghost.
  await page.waitForTimeout(600);
  await page.screenshot({ path });
  await shut(page, picker);
}

test.describe('a previous chat opened again', () => {
  test.describe.configure({ timeout: 300_000, mode: 'serial' });

  test.skip(
    process.env.PINNED_ACP_FIXTURE !== '1' || MODELS.length < 3,
    'needs the pinned ACP fixture offering models; see the header',
  );

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('offers every model and effort before it is sent anything, and leaves the other chats theirs', async ({ page, request }) => {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(join(FIXTURE, '.claude'), { recursive: true });
    const project = await fixtureProject(request);
    const command = async (data: Record<string, unknown>) => {
      const response = await request.post('/api/workbench/command', { data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json() as Promise<Record<string, unknown>>;
    };
    const written = writeChatWithHelper({ cwd: FIXTURE, sessionId: randomUUID(), card: 'reopened-1' });

    try {
      // A chat on the same account and project speaks, so what its provider
      // offers is known to the app — as it is for anyone who has used it.
      const awake = (await command({
        type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude',
      })) as { id: string };
      await command({ type: 'prompt.send', sessionId: awake.id, text: 'Say what you offer.' });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${awake.id}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
      await expect.poll(() => offered(page, 'model-picker'), { timeout: HELLO_MS }).toEqual(MODELS);
      await expect.poll(() => offered(page, 'effort-picker'), { timeout: HELLO_MS }).toEqual(EFFORTS);
      await command({ type: 'session.close', sessionId: awake.id });

      // The previous chat is opened from the list, the way he opens it.
      await page.goto(`/project?id=${project.id}&tab=chat`);
      const listed = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
      await listed.waitFor({ timeout: HELLO_MS });
      await listed.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
      // Its record has been read: the chat's own answer is on the page.
      await expect(page.locator('[data-testid="assistant-message"]').filter({ hasText: CHAT_SAID }).first())
        .toBeVisible({ timeout: HELLO_MS });
      const loadsBefore = wire().filter((asked) => asked.method === 'session/load').length;

      const controls = page.getByTestId('desktop-composer-settings');
      const model = controls.getByTestId('model-picker');
      const effort = controls.getByTestId('effort-picker');
      await expect(model).toBeVisible({ timeout: 60_000 });
      // Left a moment, so whatever the reading publishes has landed: the bug
      // was a menu arriving after the right one and replacing it.
      await page.waitForTimeout(3_000);

      const shot = process.env.REOPENED_SHOT;
      if (shot) {
        await photograph(page, 'model-picker', shot);
        if (await effort.isVisible()) await photograph(page, 'effort-picker', shot.replace(/\.png$/, '-effort.png'));
        else await page.screenshot({ path: shot.replace(/\.png$/, '-effort.png') });
      }

      // Every model the provider offers — not "Default" and the one it is on.
      await expect.poll(() => offered(page, 'model-picker'), { timeout: 60_000 }).toEqual(MODELS);
      // And the effort picker, with the provider's levels in it.
      await expect(effort, 'the reopened chat offers no effort picker').toBeVisible();
      await expect.poll(() => offered(page, 'effort-picker'), { timeout: 60_000 }).toEqual(EFFORTS);

      // A level can be chosen there and then, with nothing sent and nothing woken.
      await effort.click();
      await page.locator('[data-testid="effort-picker-option"][data-value="high"]').click();
      await expect(effort).toHaveAttribute('data-current', 'high');
      expect(wire().filter((asked) => asked.method === 'session/load')).toHaveLength(loadsBefore);

      // Reading it did not take the lists away from the other chats there
      // either. A restart forgets every live menu, so what a stopped chat is
      // offered afterwards is what the app kept of its provider's catalogue —
      // which the reading used to write its empty lists over.
      await restartInstance({
        binary: process.env.ATELIER_BINARY ?? join(__dirname, '..', '..', 'server', 'target', 'debug', 'atelier'),
        serverPort: Number(process.env.BEADS_WEB_PORT),
        sidecarPort: Number(process.env.BEADS_WORKBENCH_PORT),
        env: process.env,
        healthUrl: `${process.env.BEADS_E2E_URL}/api/workbench/health`,
        logFile: join(process.env.WORKBENCH_E2E_RUN!, 'server.log'),
      });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${awake.id}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
      await expect.poll(() => offered(page, 'model-picker'), { timeout: 60_000 }).toEqual(MODELS);
      await expect.poll(() => offered(page, 'effort-picker'), { timeout: 60_000 }).toEqual(EFFORTS);
    } finally {
      written.remove();
      await request.delete(`/api/projects/${project.id}`);
      rmSync(FIXTURE, { recursive: true, force: true });
    }
  });
});
