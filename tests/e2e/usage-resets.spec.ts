import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The plan usage panel lists the account's usage resets, each with when it
 * expires, and uses one only after a second, explicit yes.
 *
 * Read against the real account, because the resets are only readable with
 * real credentials. Using a reset cannot be taken back, so the reset request
 * never leaves this browser: the page's own call is answered here, and the
 * case proves the panel reports that answer.
 *
 * Run: BEADS_E2E_LIVE_PROVIDERS=1 scripts/workbench-e2e.sh tests/e2e/usage-resets.spec.ts
 */

const SHOTS = 'tests/results';

async function fixtureProject(request: APIRequestContext, path: string): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as { id: string; path: string }[];
  const found = listed.find((p) => p.path === path);
  if (found) return found;
  const made = await request.post('/api/projects', { data: { name: 'usage-resets', path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('usage resets', () => {
  test.use({ viewport: { width: 1100, height: 900 } });
  test.describe.configure({ timeout: 240_000 });

  test('lists each reset with its expiry and asks before using one', async ({ page, request }) => {
    const project = await fixtureProject(request, process.cwd());
    const started = (await (
      await request.post('/api/workbench/command', {
        data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' },
      })
    ).json()) as { id: string };

    // The one call that would spend a real reset is answered here, and counted.
    const sent: string[] = [];
    await page.route('**/api/workbench/usage/reset', async (route) => {
      sent.push(route.request().postData() ?? '');
      await route.fulfill({ json: { outcome: 'reset', message: 'Usage limits reset.' } });
    });
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return await route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
    const week = page.getByTestId('plan-chip-week');
    await week.waitFor({ timeout: 120_000 });
    await week.click();

    const panel = page.getByTestId('usage-view');
    await panel.waitFor();
    await page.screenshot({ path: `${SHOTS}/usage-panel-full.png` });
    const resets = page.getByTestId('usage-resets');
    await resets.waitFor({ timeout: 60_000 });
    await resets.scrollIntoViewIfNeeded();
    await expect(page.getByTestId('usage-reset').first()).toBeVisible();
    await expect(page.getByTestId('usage-reset-expiry').first()).toContainText(/Expires|Does not expire/);
    await page.screenshot({ path: `${SHOTS}/usage-resets-list.png` });

    const use = page.getByTestId('usage-reset-use').first();
    await expect(use).toBeEnabled();
    await use.click();
    const asking = page.getByTestId('usage-reset-confirmation');
    await expect(asking).toContainText('Use this reset now?');
    await page.screenshot({ path: `${SHOTS}/usage-resets-confirm.png` });
    expect(sent, 'asking must not use the reset').toHaveLength(0);

    await page.getByTestId('usage-reset-cancel').click();
    await expect(asking).toHaveCount(0);
    expect(sent, 'keeping it must not use the reset').toHaveLength(0);

    await use.click();
    await page.getByTestId('usage-reset-confirm').click();
    await expect(page.getByTestId('usage-reset-outcome')).toHaveText('Usage limits reset.');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toMatchObject({ brand: 'claude' });
    await page.screenshot({ path: `${SHOTS}/usage-resets-done.png` });
  });
});
