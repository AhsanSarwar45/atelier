import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

const FIXTURE = join(__dirname, '..', '.workbench-run-selector-defaults');
const SHOTS = join(__dirname, '..', 'results');
const HELLO_MS = 120_000;

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const found = listed.find((project) => project.path === FIXTURE);
  if (found) return found;
  const made = await request.post('/api/projects', {
    data: { name: 'selector-defaults', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

test('model and reasoning effort rows set defaults used by the next chat', async ({ page, request }) => {
  test.setTimeout(300_000);
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  const project = await fixtureProject(request);
  const started = (await (
    await request.post('/api/workbench/command', {
      data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' },
    })
  ).json()) as { id: string };

  await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

  const selected: { model?: string; effort?: string } = {};
  for (const pickerName of ['model-picker', 'effort-picker'] as const) {
    const picker = page.getByTestId(pickerName);
    await picker.waitFor({ timeout: HELLO_MS });
    await picker.click();
    const control = page.locator(`[data-testid^="${pickerName}-default-"]`).first();
    await control.waitFor();
    const value = (await control.getAttribute('data-testid'))!.slice(`${pickerName}-default-`.length);
    selected[pickerName === 'model-picker' ? 'model' : 'effort'] = value;
    const box = (await control.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const storageKey = pickerName === 'model-picker' ? 'workbench.model-defaults' : 'workbench.effort-defaults';
    await expect
      .poll(() => page.evaluate(([key, brand]) => JSON.parse(localStorage.getItem(key) ?? '{}')[brand], [storageKey, 'claude']))
      .toBe(value);

    await expect(page.getByTestId(`${pickerName}-default-${value}`)).toHaveAttribute('data-default', 'true');
    await page.getByTestId(`${pickerName}-menu`).screenshot({ path: join(SHOTS, `${pickerName}-default.png`) });
    await page.reload();
  }

  for (const [pickerName, value] of [
    ['model-picker', selected.model!],
    ['effort-picker', selected.effort!],
  ] as const) {
    await page.getByTestId(pickerName).click();
    await expect(page.getByTestId(`${pickerName}-default-${value}`)).toHaveAttribute('data-default', 'true');
    await page.keyboard.press('Escape');
  }

  let command: { type?: string; model?: string; effort?: string } | null = null;
  await page.route('/api/workbench/command', async (route) => {
    const body = route.request().postDataJSON() as { type?: string; model?: string; effort?: string };
    if (body.type === 'session.start') command = body;
    await route.fulfill({ json: { id: 'defaulted-chat' } });
  });
  await page.getByTestId('new-chat-menu').click();
  await page.getByRole('menuitem', { name: 'New Claude chat' }).click();
  await expect.poll(() => command).toMatchObject({
    type: 'session.start',
    model: selected.model,
    effort: selected.effort,
  });

  await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: started.id } });
});
