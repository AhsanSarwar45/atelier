import { expect, test, type APIRequestContext } from '@playwright/test';

const DEFAULT = 'workbench.new-chat-default';

async function projectId(request: APIRequestContext): Promise<string> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as { id: string }[];
  if (listed[0]) return listed[0].id;
  const made = await request.post('/api/projects', {
    data: { name: 'new-chat-default', path: '/tmp/new-chat-default', isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json() as { id: string }).id;
}

test('each agent row can become the persisted New Chat default', async ({ page, request }) => {
  const id = await projectId(request);
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.goto(`/project?id=${id}&tab=chat`);
  const menu = page.getByTestId('new-chat-menu');

  for (const brand of ['claude', 'codex'] as const) {
    await menu.click();
    const control = page.getByTestId(`set-new-chat-default-${brand}`);
    // Radix closes its menu as soon as a choice is made; dispatch through the
    // browser so the assertion below observes the persisted result, not a
    // control that has deliberately left the DOM.
    await control.evaluate((element: HTMLElement) => element.click());
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), DEFAULT)).toBe(brand);

    await page.reload();
    await menu.click();
    await expect(page.getByTestId(`set-new-chat-default-${brand}`)).toHaveAttribute('data-default', 'true');
    await page.keyboard.press('Escape');
  }

  await menu.click();
  await page.getByRole('menu', { name: 'New chat options' }).waitFor();
  await page.screenshot({ path: 'tests/results/new-chat-default-selector.png' });
  await page.keyboard.press('Escape');

  // The persisted Codex choice reaches the main button's real command, rather
  // than only changing the mark in this menu.
  let startedBrand: string | null = null;
  await page.route('/api/workbench/command', async (route) => {
    startedBrand = (route.request().postDataJSON() as { brand?: string }).brand ?? null;
    await route.fulfill({ json: { id: 'default-agent-chat' } });
  });
  await page.getByTestId('new-chat-tool').click();
  await expect.poll(() => startedBrand).toBe('codex');
});
