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
  test.describe.configure({ timeout: 300_000 });

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
    const started = (await (
      await request.post('/api/workbench/command', {
        data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' },
      })
    ).json()) as { id: string };

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
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

    // And the other half of it: a picker is not a change to this one chat. Pick
    // any model that is not the one the settings hold, and the file holds it.
    // Not the list's top row either — that one is the brand's own default, and
    // picking it means the key comes OUT rather than being written.
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
    await expect
      .poll(() => settings().model, { timeout: 15_000, message: 'his settings file never took the pick' })
      .toBe(picked);
    // Everything else in the file is left exactly as he wrote it.
    expect(settings().permissions?.defaultMode).toBe('plan');

    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: started.id } });
  });
});
