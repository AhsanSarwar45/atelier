import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The model menu offers every model this Claude install answers to, not the
 * handful of names it advertises (bw-xtic).
 *
 * The fault: the driver rendered `supportedModels()` verbatim, and that returns
 * only the aliases — `opus`, `sonnet`, `haiku`, `fable` — each pinned to
 * whatever shipped last. Every numbered release the install still serves, Opus
 * 4.8 and 4.5 among them, was unreachable from the browser even though typing
 * its id into a settings file worked. Separately, an option's description was
 * drawn as a sibling of the clickable row, so it fell outside both the click
 * target and the highlight.
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
  test.describe.configure({ timeout: 300_000 });

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

  test('offers the numbered versions under the aliases, and marks what cannot be run', async ({
    page,
    request,
  }) => {
    const project = await fixtureProject(request);
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    // Nobody has said which agent this project uses, so it asks. Claude, since
    // the models under test are Claude's.
    const asking = page.getByTestId('new-chat-provider-dialog');
    await asking.waitFor({ timeout: HELLO_MS });
    await page.getByTestId('new-chat-provider-claude').click();
    await asking.getByRole('button', { name: 'Start chat' }).click();
    await page.waitForURL((url) => Boolean(url.searchParams.get('chat')), { timeout: HELLO_MS });
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

    const model = page.getByTestId('model-picker');
    await expect(model).not.toHaveText('Model', { timeout: HELLO_MS });
    await model.click();

    const options = page.getByTestId('model-picker-option');
    await options.first().waitFor({ timeout: HELLO_MS });

    // The aliases the install advertises are still there, and still first.
    const values = await options.evaluateAll((rows) =>
      rows.map((row) => (row as HTMLElement).dataset.value ?? ''),
    );
    // An alias is whatever this install calls it — `opus[1m]` on one machine,
    // `opus` on another — so the one asserted on is the one that never varies.
    expect(values, 'the aliases the install advertises were dropped').toContain('sonnet');
    // …and the numbered releases it never named are underneath them.
    expect(values, 'no numbered version reached the menu').toContain('claude-opus-4-5');
    expect(values.indexOf('sonnet'), 'a numbered version was listed above the aliases').toBeLessThan(
      values.indexOf('claude-opus-4-5'),
    );

    // One rule, drawn where the aliases give way to the versions.
    await expect(page.getByTestId('model-picker-menu').getByRole('separator')).toHaveCount(1);

    // A row says what it is inside the row itself rather than beside it, so the
    // description is part of what a click lands on and part of what lights up.
    const lit = page.locator('[data-testid="model-picker-option"][data-value="claude-opus-4-5"]');
    await expect(lit.getByTestId('model-picker-option-hint')).not.toBeEmpty();

    // A model this install cannot run is still shown, with the reason in place
    // of the description, and it is marked as not for choosing.
    const shut = page.locator('[data-testid="model-picker-option"][data-unavailable="true"]').first();
    await expect(shut).toHaveAttribute('aria-disabled', 'true');
    await expect(shut.getByTestId('model-picker-option-hint')).not.toBeEmpty();

    // The menu is taller than the box it scrolls in, so the proof is taken in
    // bands: the aliases at the top, the rule and the versions under it, and
    // the far end where the ones that cannot be run are.
    const menu = page.getByTestId('model-picker-menu');
    const shot = async (name: string) =>
      menu.screenshot({ path: `${SHOTS}/model-menu-${name}.png` });
    /** Scrolls the box itself, since hovering a row would scroll it too. */
    const scrollTo = async (top: number) => {
      await menu.evaluate((box, to) => box.scrollTo({ top: to }), top);
      await expect.poll(() => menu.evaluate((box) => box.scrollTop)).toBe(top);
    };

    // The last of the aliases, at the top.
    await scrollTo(0);
    await shot('aliases');

    // The rule itself, with aliases above it and numbered versions below.
    const rule = await menu
      .getByRole('separator')
      .evaluate((line) => (line as HTMLElement).offsetTop);
    await scrollTo(Math.max(0, rule - 150));
    await shot('separator');

    // A row lit up, to show the description highlighting with its own label.
    await lit.hover();
    await expect(lit).toHaveAttribute('data-highlighted', '');
    await shot('highlighted');

    // The far end, where the models this install cannot run are marked.
    await scrollTo(await menu.evaluate((box) => box.scrollHeight - box.clientHeight));
    await shot('unavailable');

    // And a version the install never advertised is a version it will take.
    await lit.click();
    await expect(model).toHaveAttribute('data-current', 'claude-opus-4-5', { timeout: HELLO_MS });
  });
});
