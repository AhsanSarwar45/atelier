import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The model menu is the active provider's advertised catalog. Atelier does not
 * carry a second release list that can become stale or offer a model this
 * account, adapter or runtime cannot actually select.
 *
 * The unit cases under src/workbench/__tests__ and workbench/src/__tests__
 * prove the merge and the markup on their own. This one proves the two ends are
 * joined through the real server, the real sidecar and a real agent — that what
 * the install knows is what the reader is offered, and that the picture the job
 * is signed off on is a picture of the running app.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-model-catalog.spec.ts
 */

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** Starting an agent is a process launch. */
const HELLO_MS = 120_000;

/** A folder of its own, so this case never runs an agent in someone's work. */
const FIXTURE = join(__dirname, '..', '.workbench-run-model-catalog');

/** The width this is looked at, with both columns open. */
const SCREEN = { width: 1440, height: 1000 };
const PROVIDERS = ['claude', 'codex'] as const;

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
    data: { name: 'workbench-model-catalog', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('the model menu', () => {
  test.use({ viewport: SCREEN });
  test.describe.configure({ timeout: 300_000, mode: 'serial' });

  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(join(FIXTURE, '.claude'), { recursive: true });
  });

  /**
   * A test project is left off the plain list, which is the list the project
   * page itself reads — so this page asks for them too, and a real visitor
   * typing the same address still sees none.
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  for (const brand of PROVIDERS) test(`${brand} draws exactly its active provider catalog and can select one of its models`, async ({
    page, request,
  }) => {
    const project = await fixtureProject(request);
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    // Nobody has said which agent this project uses, so it asks. The catalog
    // must come from the selected agent rather than a shared release list.
    const asking = page.getByTestId('new-chat-provider-dialog');
    await asking.waitFor({ timeout: HELLO_MS });
    await page.getByTestId(`new-chat-provider-${brand}`).click();
    await asking.getByRole('button', { name: 'Start chat' }).click();
    await page.waitForURL((url) => Boolean(url.searchParams.get('chat')), { timeout: HELLO_MS });
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

    const model = page.getByTestId('model-picker');
    await expect(model).not.toHaveText('Model', { timeout: HELLO_MS });
    await model.click();

    const options = page.getByTestId('model-picker-option');
    await options.first().waitFor({ timeout: HELLO_MS });

    const values = await options.evaluateAll((rows) =>
      rows.map((row) => (row as HTMLElement).dataset.value ?? ''),
    );
    expect(values.length, 'the provider advertised no selectable model').toBeGreaterThan(0);
    const sessionId = new URL(page.url()).searchParams.get('chat')!;
    const database = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'), { readOnly: true });
    const row = database.prepare(
      "SELECT json FROM event WHERE session_id = ? AND type = 'session.menu' ORDER BY seq DESC LIMIT 1",
    ).get(sessionId) as { json: string };
    database.close();
    const advertised = (JSON.parse(row.json) as { models: { value: string }[] }).models.map((choice) => choice.value);
    expect(values).toEqual(advertised);
    for (const option of await options.all()) await expect(option).not.toHaveText('');

    const menu = page.getByTestId('model-picker-menu');
    await menu.screenshot({ path: `${SHOTS}/${brand === 'claude' ? 'model-menu-provider-catalog' : 'model-menu-codex-provider-catalog'}.png` });
    const current = await model.getAttribute('data-current');
    const selectable = values.find((value) => value !== current);
    if (selectable) {
      await options.nth(values.indexOf(selectable)).click();
      await expect(model).toHaveAttribute('data-current', selectable, { timeout: HELLO_MS });
    }
  });
});
