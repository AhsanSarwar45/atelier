import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { discardFixture, makeFixtureProject } from './fixture-board';

/**
 * A copy copies on a page opened at a plain http address that is not this
 * computer — the way a phone reaches the app over remote access (bw-oo16q).
 *
 * There the browser takes `navigator.clipboard` away, and every copy in the
 * app was written against it alone, so each one silently did nothing. The case
 * copies a chat's ID from the sidebar and pastes it, with the real paste key,
 * into the chatbox.
 *
 * Run it on an address Chrome does not count as secure:
 *
 *   BEADS_WEB_HOST=172.17.0.1 scripts/workbench-e2e.sh tests/e2e/copying-over-plain-http.spec.ts
 */

const HELLO_MS = 120_000;

interface Project {
  id: string;
  path: string;
}

const backend = () => process.env.BEADS_E2E_BACKEND ?? '';

const made: { run: string; id?: string }[] = [];

async function theProject(request: APIRequestContext): Promise<Project> {
  const run = join(process.cwd(), 'tests', '.workbench-run-copy-over-http');
  const path = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const kept: { run: string; id?: string } = { run };
  made.push(kept);
  const answer = await request.post(`${backend()}/api/projects`, {
    data: { name: 'copy over http', path, isTest: true },
  });
  expect(answer.status(), await answer.text()).toBe(201);
  const project = (await answer.json()) as Project;
  kept.id = project.id;
  return project;
}

async function aChat(request: APIRequestContext, project: Project): Promise<string> {
  const started = await request.post(`${backend()}/api/workbench/command`, {
    data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' },
  });
  expect(started.ok(), await started.text()).toBe(true);
  return ((await started.json()) as { id: string }).id;
}

test.describe('Copying over plain http', () => {
  test.describe.configure({ timeout: 300_000 });

  test.afterEach(async ({ request }) => {
    for (const { run, id } of made.splice(0)) {
      if (id) await request.delete(`${backend()}/api/projects/${id}`);
      try {
        discardFixture(run);
      } catch {
        await new Promise((done) => setTimeout(done, 5_000));
        discardFixture(run);
      }
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('Copy ID still copies, and pastes into the chatbox', async ({ page, request }) => {
    const project = await theProject(request);
    const other = await aChat(request, project);
    const here = await aChat(request, project);

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${here}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    // The page this case is about: one the browser gives no clipboard API.
    expect(await page.evaluate(() => ({ secure: window.isSecureContext, api: 'clipboard' in navigator })))
      .toEqual({ secure: false, api: false });

    const row = page.locator(`[data-testid="restore-row"][data-row-key="${other}"]`);
    await row.waitFor({ timeout: HELLO_MS });
    await row.click({ button: 'right' });
    await page.getByTestId('chat-menu-copy-id').click();
    await expect(page.getByText('Chat ID copied')).toBeVisible();
    await page.screenshot({ path: 'tests/results/bw-oo16q-copied.png' });

    const writing = page.getByTestId('composer-frame').locator('.cm-content');
    await writing.click();
    await page.keyboard.press('Control+V');
    await expect(page.getByTestId('composer')).toHaveValue(`@chat:${other} `);
    await page.screenshot({ path: 'tests/results/bw-oo16q-pasted.png' });
  });
});
