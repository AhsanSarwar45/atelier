import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * A chat opened while the app is already running draws its plan chip at once.
 *
 * The server used to send a page no usage when it connected, and read every
 * account one after another before sending any, so a Codex chat opened
 * between beats of the poller showed no chip for up to half a minute, longer
 * behind a slow Claude reading (bw-kde0.1). Read against the real account,
 * because the plan figure is only readable with real credentials.
 *
 * Run: BEADS_E2E_LIVE_PROVIDERS=1 scripts/workbench-e2e.sh tests/e2e/usage-chip-at-once.spec.ts
 */

const SHOTS = 'tests/results';

async function fixtureProject(request: APIRequestContext, path: string): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as { id: string; path: string }[];
  const found = listed.find((p) => p.path === path);
  if (found) return found;
  const made = await request.post('/api/projects', { data: { name: 'usage-chip', path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test.describe('plan chip', () => {
  test.use({ viewport: { width: 1100, height: 700 } });
  test.describe.configure({ timeout: 240_000 });

  test('a Codex chat opened while the app runs shows its chip at once', async ({ browser, request }) => {
    const project = await fixtureProject(request, process.cwd());
    const start = async () =>
      (
        (await (
          await request.post('/api/workbench/command', {
            data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'codex' },
          })
        ).json()) as { id: string }
      ).id;
    const open = async (chat: string) => {
      const page = await browser.newPage();
      await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return await route.continue();
        const url = new URL(route.request().url());
        url.searchParams.set('include_test', 'true');
        await route.continue({ url: url.toString() });
      });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${chat}`);
      return page;
    };

    // The app is already open somewhere, and has read the account once.
    const first = await open(await start());
    await first.getByTestId('plan-chip-week').waitFor({ timeout: 120_000 });

    // Well clear of the beat that just happened, so the next is far away.
    await first.waitForTimeout(3_000);
    const second = await open(await start());
    await second.getByTestId('composer').first().waitFor();
    const began = Date.now();
    await second.getByTestId('plan-chip-week').waitFor({ timeout: 60_000 });
    const took = Date.now() - began;
    console.log(`plan chip appeared ${took} ms after the chat drew`);
    await second.screenshot({ path: `${SHOTS}/usage-chip-at-once.png` });
    expect(took, 'the chip waited for the next beat of the poller').toBeLessThan(3_000);
  });
});
