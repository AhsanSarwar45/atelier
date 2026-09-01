import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { BRAND_DEFAULT_MODEL } from '../../src/workbench/protocol';

/**
 * A chat opens on the settings the owner already keeps, and a picker he touches
 * changes them for good rather than for that one chat (bw-7ks.23).
 *
 * The fault: every chat the app started was handed the literal `default` — ask
 * before every tool — and handing it over explicitly beat `permissions.
 * defaultMode` in his own settings, so a machine configured once still opened
 * every new chat asking about everything (bw-b1o1). The unit cases under
 * workbench/src/__tests__ prove which file wins and where a change lands; this
 * one proves the two ends are joined through the real server, the real sidecar
 * and the real agent — that what the header shows is what the settings say.
 *
 * The settings under test are the FIXTURE PROJECT's own `.claude/settings.json`,
 * which is a layer above the owner's and below nothing: the case can say what a
 * chat must open on without touching a file on his machine, and the write-back
 * lands in the fixture rather than in his home.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-settings.spec.ts
 */

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** Starting an agent is a process launch. */
const HELLO_MS = 120_000;

/** A folder of its own, so this case never runs an agent in someone's work. */
const FIXTURE = join(__dirname, '..', '.workbench-run-settings');

/** The file this case writes, and the app reads back. */
const SETTINGS = join(FIXTURE, '.claude', 'settings.json');

/** What the owner has already set, in the kit's own spelling: plan only, on Sonnet. */
const SET = { model: 'sonnet', permissions: { defaultMode: 'plan' } };

/** The width this is looked at, with both columns open. */
const SCREEN = { width: 1440, height: 900 };

const settings = () =>
  JSON.parse(readFileSync(SETTINGS, 'utf8')) as { model?: string; permissions?: { defaultMode?: string } };

/**
 * A project of this run's own, marked as a test project so it stays off the
 * owner's dashboard and is swept up rather than living on his machine.
 */
async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const found = listed.find((p) => p.path === FIXTURE);
  if (found) return found;
  const made = await request.post('/api/projects', {
    data: { name: 'workbench-settings', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('a chat the app starts', () => {
  test.use({ viewport: SCREEN });
  // Both cases deliberately share one settings file and one project. Running
  // them in parallel races project creation and lets one case rewrite the
  // setting while the other is asserting it.
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(join(FIXTURE, '.claude'), { recursive: true });
    writeFileSync(SETTINGS, `${JSON.stringify(SET, null, 2)}\n`, 'utf8');
  });

  /**
   * A test project is left off the plain list, which is the list the project
   * page itself reads — so this page asks for them too, and a real visitor
   * typing the same address still sees none (as workbench.spec.ts does).
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('opens on the settings he already keeps, and keeps what he picks', async ({ page, request }) => {
    const project = await fixtureProject(request);
    // No mode and no model are named here: the whole point is that nobody has
    // to name them, and that the app no longer invents one when nobody does.
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    // With the default set to "ask", New Chat first asks which provider owns
    // this conversation. Confirm the preselected Claude choice instead of
    // waiting for navigation while the dialog is still open.
    await page.getByTestId('new-chat-provider-dialog').getByRole('button', { name: 'Start chat' }).click();
    await page.waitForURL((url) => Boolean(url.searchParams.get('chat')), { timeout: HELLO_MS });
    const started = { id: new URL(page.url()).searchParams.get('chat')! };
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

    const mode = page.getByTestId('mode-picker');
    const model = page.getByTestId('model-picker');

    // The mode the settings name, on the chat and on the screen — and in words
    // a reader can act on rather than the setting's own spelling.
    await expect(mode).toHaveAttribute('data-current', 'plan', { timeout: HELLO_MS });
    await expect(mode).toHaveText('Plan only');

    // The model likewise, and not the empty slot this used to be: the picker
    // draws the name the settings hold whether or not the kit's own list has a
    // prettier one for it.
    await expect(model).toHaveAttribute('data-current', SET.model, { timeout: HELLO_MS });
    await expect(model).not.toHaveText('Model');

    // The whole writing box, not the two chips alone: what the picture has to
    // show is a chat nobody has touched, already standing in his own settings.
    const frame = (await page.getByTestId('composer-frame').boundingBox())!;
    await page.screenshot({
      path: `${SHOTS}/chat-opens-on-his-settings.png`,
      clip: { x: frame.x - 8, y: frame.y - 8, width: frame.width + 16, height: frame.height + 16 },
    });

    // And the other half of it: an ordinary pick changes this chat only. The
    // separate star control changes provider defaults; steering one live chat
    // must not silently rewrite what every future terminal or chat starts on.
    await model.click();
    const chosen = page
      .locator(
        `[data-testid="model-picker-option"]:not([data-picked="true"]):not([data-value="${BRAND_DEFAULT_MODEL}"])`,
      )
      .first();
    await chosen.waitFor({ timeout: HELLO_MS });
    const picked = (await chosen.getAttribute('data-value'))!;
    expect(picked, 'the menu offered nothing but the model already set').not.toBe(SET.model);
    await chosen.click();

    await expect(model).toHaveAttribute('data-current', picked, { timeout: HELLO_MS });
    expect(settings().model).toBe(SET.model);
    expect(settings().permissions?.defaultMode).toBe('plan');

    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: started.id } });
  });

  test('shows all live chat settings in the mobile composer modal', async ({ page, request }) => {
    const project = await fixtureProject(request);
    const response = await request.post('/api/workbench/command', {
      data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const started = (await response.json()) as { id: string };

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
      await page.getByTestId('mobile-composer-settings').click();
      await expect(page.getByTestId('mobile-mode-picker')).toBeVisible({ timeout: HELLO_MS });
      await expect(page.getByTestId('mobile-model-picker')).toBeVisible({ timeout: HELLO_MS });
      await expect(page.getByTestId('mobile-effort-picker')).toBeVisible({ timeout: HELLO_MS });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/mobile-chat-settings-after.png`, fullPage: true });
    } finally {
      await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: started.id } });
    }
  });
});
