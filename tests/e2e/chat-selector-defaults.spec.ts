import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const FIXTURE = join(__dirname, '..', '.workbench-run-selector-defaults');
const SHOTS = join(__dirname, '..', 'results');
const HELLO_MS = 120_000;

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as { id: string; path: string }[];
  const found = listed.find((project) => project.path === FIXTURE);
  if (found) return found;
  const made = await request.post('/api/projects', { data: { name: 'selector-defaults', path: FIXTURE, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

async function setAndProve(page: Page, request: APIRequestContext, brand: 'claude' | 'codex', pickerName: 'model-picker' | 'effort-picker'): Promise<void> {
  const kind = pickerName === 'model-picker' ? 'model' : 'effort';
  await page.getByTestId(pickerName).click();
  const controls = page.locator(`[data-testid^="${pickerName}-default-"]:not([disabled])`);
  const count = await controls.count();
  let control = controls.first();
  for (let i = 0; i < count; i += 1) {
    const candidate = controls.nth(i);
    const candidateValue = (await candidate.getAttribute('data-testid'))!.slice(`${pickerName}-default-`.length);
    if (candidateValue !== 'default' && !candidateValue.includes('[')) { control = candidate; break; }
  }
  const value = (await control.getAttribute('data-testid'))!.slice(`${pickerName}-default-`.length);
  const [writeRequest] = await Promise.all([
    page.waitForRequest((sent) => {
      if (!sent.url().endsWith('/api/workbench/command')) return false;
      const body = sent.postDataJSON() as { type?: string };
      return body.type === 'provider-defaults.write';
    }),
    control.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0 }),
  ]);
  const writeResponse = await writeRequest.response();
  expect(writeResponse?.ok(), await writeResponse?.text()).toBeTruthy();
  await expect(page.getByTestId(`${pickerName}-default-${value}`)).toHaveAttribute('data-default', 'true');
  await expect.poll(async () => {
    const response = await request.post('/api/workbench/command', { data: { type: 'provider-defaults.read', brand } });
    const defaults = await response.json() as { model: string | null; effort: string | null };
    return defaults[kind];
  }).toBe(value);
  await page.getByTestId(`${pickerName}-menu`).screenshot({ path: join(SHOTS, `${brand}-${pickerName}-default.png`) });
  await page.reload();
  await page.getByTestId(pickerName).click();
  await expect(page.getByTestId(`${pickerName}-default-${value}`)).toHaveAttribute('data-default', 'true');
  await page.keyboard.press('Escape');
}

test('Claude and Codex model and effort defaults use provider-native configuration', async ({ page, request }) => {
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

  for (const brand of ['claude', 'codex'] as const) {
    const response = await request.post('/api/workbench/command', {
      data: { type: 'session.start', projectId: project.id, projectPath: project.path, brand },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const started = (await response.json()) as { id: string };
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
    await page.waitForTimeout(2_000);
    await setAndProve(page, request, brand, 'model-picker');
    await setAndProve(page, request, brand, 'effort-picker');
    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: started.id } });
  }

  expect(await page.evaluate(() => localStorage.getItem('workbench.model-defaults'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('workbench.effort-defaults'))).toBeNull();
});
