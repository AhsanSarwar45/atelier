import { readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The mode and the effort a chat was set to are still set after a message.
 *
 * Setting them and then typing is the ordinary order — you pick how much rope
 * the agent gets and only then say what to do — and it was the one order that
 * threw the picks away. Sending to a chat with no agent running starts one, and
 * a started agent comes up at its own defaults; Atelier read those defaults
 * back over the picks and sent them to the chips, so the mode snapped to
 * "Ask first" and the effort to its default a moment after the message went.
 * The picks were gone from the record too, not just the screen (bw-l4fr.1).
 *
 * The agent here is a fixture that forgets on purpose, so anything the chips
 * say after the second message is something Atelier put back.
 *
 * Run: PINNED_ACP_FIXTURE=1 \
 *      ATELIER_ACP_CLAUDE_PATH="$PWD/tests/fixtures/acp-adapters/pinned-acp" \
 *      CLAUDE_PATH="$PWD/tests/fixtures/acp-adapters/claude" \
 *      PINNED_ACP_WIRE="$PWD/tests/.e2e-run/pinned-acp-wire.jsonl" \
 *      scripts/workbench-e2e.sh tests/e2e/pinned-settings-survive-a-send.spec.ts
 */

/** Starting an agent and hearing back what it can do is a process launch. */
const HELLO_MS = 120_000;

/** What the chat is set to. Neither is the fixture agent's own default. */
const MODE = 'bypassPermissions';
const EFFORT = 'high';

function backend(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

interface Project {
  id: string;
  path: string;
}

const PROJECT_PATH = process.cwd();

/** The project at our path, made if nobody has made it yet. */
async function pinnedProject(request: APIRequestContext): Promise<Project> {
  const api = backend();
  const there = async (): Promise<Project | undefined> => {
    const listed = (await (
      await request.get(`${api}/api/projects?include_test=true`)
    ).json()) as Project[];
    return listed.find((p) => p.path === PROJECT_PATH);
  };
  const found = await there();
  if (found) return found;
  const made = await request.post(`${api}/api/projects`, {
    data: { name: 'pinned-settings', path: PROJECT_PATH, isTest: true },
  });
  if (made.status() === 201) return (await made.json()) as Project;
  const said = await made.text();
  const raced = await there();
  expect(raced, `no project at ${PROJECT_PATH}, and it could not be made: ${said}`).toBeTruthy();
  return raced!;
}

interface Asked {
  method: string;
  params?: { modeId?: string; configId?: string; value?: unknown };
}

/** Everything the fixture agent was asked, in the order it was asked. */
function wire(): Asked[] {
  const path = process.env.PINNED_ACP_WIRE;
  if (!path) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Asked);
  } catch {
    return [];
  }
}

test.describe('what a chat is set to survives sending a message', () => {
  // Two agent launches, each one a process.
  test.describe.configure({ timeout: 300_000 });

  test.skip(
    process.env.PINNED_ACP_FIXTURE !== '1',
    'needs the forgetful ACP fixture; see the header',
  );

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('the mode and effort set before a message are still set after it', async ({ page, request }) => {
    const api = backend();
    const project = await pinnedProject(request);
    const command = async (data: Record<string, unknown>) => {
      const response = await request.post(`${api}/api/workbench/command`, { data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json() as Promise<Record<string, unknown>>;
    };

    const started = (await command({
      type: 'session.start',
      projectId: project.id,
      projectPath: project.path,
      brand: 'claude',
    })) as { id: string };
    const chat = started.id;

    // The first message is what mints the provider session, so that there is
    // something to come back to.
    await command({ type: 'prompt.send', sessionId: chat, text: 'The first message.' });

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${chat}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

    // Set from the chat, the way he does it.
    await command({ type: 'session.mode', sessionId: chat, mode: MODE });
    await command({ type: 'session.effort', sessionId: chat, effort: EFFORT });

    const mode = page.getByTestId('chat-mode-chip');
    const effort = page.getByTestId('chat-effort-chip');
    await expect.poll(() => mode.getAttribute('data-mode'), { timeout: 60_000 }).toBe(MODE);
    await expect.poll(() => effort.getAttribute('data-effort'), { timeout: 60_000 }).toBe(EFFORT);

    // The agent goes away, as it does when a chat is left alone. Its successor
    // will know nothing of either pick.
    await command({ type: 'session.close', sessionId: chat });
    const q = new URLSearchParams({ project: project.id, path: project.path, all: '1' });
    const stateOf = async (): Promise<string | undefined> => {
      const rows = (await (await request.get(`${api}/api/workbench/restore?${q}`)).json()) as {
        sessionId: string | null;
        state: string;
      }[];
      return rows.find((r) => r.sessionId === chat)?.state;
    };
    await expect.poll(stateOf, { timeout: 60_000 }).toBe('dormant');

    const beforeSecond = wire().length;

    // The message that used to undo both picks.
    await command({ type: 'prompt.send', sessionId: chat, text: 'The second message.' });

    await page.reload();
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

    // The line itself, photographed before it is asserted on, so that the shot
    // is of whatever the app actually settled at rather than of a state the
    // case waited for. A broken build photographs its own failure.
    const shot = process.env.PINNED_ACP_SHOT;
    if (shot) {
      await mode.waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1_500);
      await page.getByTestId('chat-status-line').screenshot({ path: shot });
    }

    await expect.poll(() => mode.getAttribute('data-mode'), { timeout: 60_000 }).toBe(MODE);
    await expect.poll(() => effort.getAttribute('data-effort'), { timeout: 60_000 }).toBe(EFFORT);

    // And the agent was told, rather than the screen merely being kept tidy —
    // an agent that was not told would run the turn at its own defaults however
    // the chips read.
    const woken = wire().slice(beforeSecond);
    const loaded = woken.findIndex((asked) => asked.method === 'session/load');
    expect(loaded, 'the second message did not resume the saved chat').toBeGreaterThanOrEqual(0);
    const after = woken.slice(loaded);
    expect(
      after.some((a) => a.method === 'session/set_mode' && a.params?.modeId === MODE),
      `the resumed agent was never told the mode: ${JSON.stringify(after)}`,
    ).toBe(true);
    expect(
      after.some(
        (a) =>
          a.method === 'session/set_config_option' &&
          a.params?.configId === 'reasoning_effort' &&
          JSON.stringify(a.params?.value ?? '').includes(EFFORT),
      ),
      `the resumed agent was never told the effort: ${JSON.stringify(after)}`,
    ).toBe(true);
  });

  test('a previous chat can change effort before its first new message', async ({ page, request }) => {
    const api = backend();
    const project = await pinnedProject(request);
    const command = async (data: Record<string, unknown>) => {
      const response = await request.post(`${api}/api/workbench/command`, { data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json() as Promise<Record<string, unknown>>;
    };

    // One chat asks the installed provider for its current catalogue.
    const awake = (await command({
      type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude',
    })) as { id: string };
    await command({ type: 'prompt.send', sessionId: awake.id, text: 'Advertise the current controls.' });

    // This saved chat has never sent anything, so it owns no menu and opening
    // it must not wake an agent merely to draw the composer controls.
    const saved = (await command({
      type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude',
    })) as { id: string };
    await command({ type: 'session.close', sessionId: saved.id });
    const launchesBeforeOpen = wire().filter((asked) => asked.method === 'session/new').length;

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${saved.id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    const mode = page.getByTestId('mode-picker');
    const effort = page.getByTestId('effort-picker');
    await expect(mode).toBeVisible({ timeout: 60_000 });
    await expect(effort).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('chat-model-chip')).toHaveCount(0);
    await expect(page.getByTestId('chat-mode-chip')).toHaveCount(0);
    await expect(page.getByTestId('chat-effort-chip')).toHaveCount(0);

    await effort.click();
    await page.locator('[data-testid="effort-picker-option"][data-value="high"]').click();
    await expect(effort).toHaveAttribute('data-current', EFFORT);
    expect(wire().filter((asked) => asked.method === 'session/new')).toHaveLength(launchesBeforeOpen);

    const shot = process.env.PINNED_ACP_SHOT;
    if (shot) await page.screenshot({ path: shot, fullPage: true });
  });

  test('a cold old Codex chat draws its four controls with no live menu', async ({ page, request }) => {
    const api = backend();
    const project = await pinnedProject(request);
    const response = await request.post(`${api}/api/workbench/command`, { data: {
      type: 'session.open',
      externalId: `cold-old-${Date.now()}`,
      projectId: project.id,
      projectPath: project.path,
      cwd: project.path,
      brand: 'codex',
      model: 'gpt-5.6-sol',
      permissionMode: 'on-request',
      effort: 'low',
      collaborationMode: 'default',
    } });
    expect(response.ok(), await response.text()).toBe(true);
    const saved = (await response.json()) as { id: string };

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${saved.id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    const controls = page.getByTestId('desktop-composer-settings');
    await expect(controls.getByTestId('session-brand')).toHaveCount(0);
    await expect(controls.getByTestId('model-picker')).toBeVisible();
    await expect(controls.getByTestId('mode-picker')).toBeVisible();
    await expect(controls.getByTestId('effort-picker')).toBeVisible();
    await expect(controls.getByTestId('collaboration-mode-picker')).toBeVisible();

    await controls.getByTestId('effort-picker').click();
    await page.locator('[data-testid="effort-picker-option"][data-value="high"]').click();
    await expect(controls.getByTestId('effort-picker')).toHaveAttribute('data-current', 'high');

    const status = page.getByTestId('chat-status-line');
    await expect(status.getByTestId('session-brand')).toHaveCount(0);
    await expect(status.getByTestId('chat-model-chip')).toHaveCount(0);
    await expect(status.getByTestId('chat-mode-chip')).toHaveCount(0);
    await expect(status.getByTestId('chat-effort-chip')).toHaveCount(0);
    const shot = process.env.PINNED_ACP_SHOT;
    if (shot) await page.screenshot({ path: shot, fullPage: true });
  });
});
