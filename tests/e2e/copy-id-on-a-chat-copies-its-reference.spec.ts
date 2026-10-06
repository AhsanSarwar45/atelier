import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { discardFixture, makeFixtureProject } from './fixture-board';

/**
 * Copy ID on a sidebar chat copies the reference the composer reads,
 * `@chat:<id>`, so pasting it into the chatbox names that chat (bw-93pyq).
 *
 * A real clipboard: the menu writes it, the case reads it back, and then
 * pastes what it read into the composer, which draws the chat's badge.
 *
 *   scripts/workbench-e2e.sh tests/e2e/copy-id-on-a-chat-copies-its-reference.spec.ts
 */

const HELLO_MS = 120_000;

interface Project {
  id: string;
  path: string;
}

const backend = () => process.env.BEADS_E2E_BACKEND ?? '';

const made: { run: string; id?: string }[] = [];

async function theProject(request: APIRequestContext): Promise<Project> {
  const run = join(process.cwd(), 'tests', '.workbench-run-copy-chat-id');
  const path = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const kept: { run: string; id?: string } = { run };
  made.push(kept);
  const answer = await request.post(`${backend()}/api/projects`, {
    data: { name: 'copy chat id', path, isTest: true },
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

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test.describe('Copy ID on a sidebar chat', () => {
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

  test('copies @chat:<id>, which pasted into the chatbox is that chat', async ({ page, request }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const project = await theProject(request);
    const other = await aChat(request, project);
    const here = await aChat(request, project);

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${here}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    await page.evaluate(() => navigator.clipboard.writeText('nothing has been copied yet'));

    const row = page.locator(`[data-testid="restore-row"][data-row-key="${other}"]`);
    await row.waitFor({ timeout: HELLO_MS });
    await row.click({ button: 'right' });
    const menu = page.getByTestId('chat-context-menu');
    await expect(menu).toBeVisible();
    await page.getByTestId('chat-menu-copy-id').click();
    await expect.poll(() => clipboard(page), { message: 'the menu did not copy the chat as @chat:<id>' }).toBe(`@chat:${other}`);
    await page.screenshot({ path: 'tests/results/bw-93pyq-copied.png' });

    // Pasted into the chatbox, what was copied is that chat's badge.
    const writing = page.getByTestId('composer-frame').locator('.cm-content');
    await writing.click();
    const copied = await clipboard(page);
    await writing.evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, copied);
    await expect(page.getByTestId('composer')).toHaveValue(`@chat:${other} `);
    const badge = page.getByTestId('composer-frame').getByTestId('composer-reference');
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveAttribute('data-reference-kind', 'chat');
    await expect(badge).toHaveAttribute('data-reference-id', other);
    await page.screenshot({ path: 'tests/results/bw-93pyq-pasted.png' });
  });
});
