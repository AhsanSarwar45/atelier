import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
const run = process.env.WORKBENCH_E2E_RUN!;
const results = 'tests/results/shared-library';
let project: { id: string; path: string };
const api = '/api/settings/library';
async function save(request: APIRequestContext, library: unknown, path?: string) {
  const url = path ? `${api}?path=${encodeURIComponent(path)}` : api;
  const held = await (await request.get(url)).json();
  const saved = await request.put(url, { data: { library, revision: held.revision } });
  expect(saved.ok(), await saved.text()).toBeTruthy(); return saved.json();
}
async function add(page: Page, kind: 'instruction' | 'skill' | 'output style', id: string, name: string, content: string) {
  await page.getByRole('button', { name: `Add ${kind}`, exact: true }).click();
  await page.getByTestId('editor-advanced').locator('summary').click();
  await page.getByLabel('Item ID', { exact: true }).fill(id);
  await page.getByLabel('Item name', { exact: true }).fill(name);
  await page.getByLabel('Item content', { exact: true }).fill(content);
}
async function saved(page: Page) {
  await page.getByRole('button', { name: 'Save item', exact: true }).click();
  await expect(page.getByTestId('library-editor')).toHaveCount(0);
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(page.getByRole('listbox', { includeHidden: true })).toHaveCount(0);
}
test.beforeAll(async ({ request }) => {
  expect(run, 'run through the isolated harness').toBeTruthy();
  mkdirSync(join(run, 'projects'), { recursive: true }); mkdirSync(results, { recursive: true });
  const path = mkdtempSync(join(run, 'projects', 'library-'));
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }));
  const made = await request.post('/api/projects', { data: { name: 'Shared guidance demo', path } });
  expect(made.status(), await made.text()).toBe(201); project = await made.json();
  expect((await request.get(`/api/projects/${project.id}/settings`)).ok()).toBeTruthy();
  await save(request, { items: [], overrides: {} });
});
test.afterAll(async ({ request }) => { if (project) await request.delete(`/api/projects/${project.id}`); });

test('global and project editors persist conditional skills, instructions and exclusive styles', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings?section=library');
  await expect(page.getByTestId('shared-library')).toBeVisible();
  await add(page, 'instruction', 'shared-conventions', 'Shared conventions', 'When asked for the library proof, include GLOBAL-READY.');
  await saved(page);
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await add(page, 'skill', 'frontend-review', 'Frontend review', 'Read the supporting resource checklist.md with atelier_skill_read. Return its proof code and {{framework}}.');
  await page.getByLabel('Item description').fill('Use when asked to perform the shared frontend review.');
  await choose(page, 'Condition', 'Package declares dependency');
  await page.getByLabel('Dependency name').fill('next');
  await page.getByTestId('editor-support').locator('summary').click();
  await page.getByRole('button', { name: 'Add parameters', exact: true }).click();
  await page.getByLabel('Parameters name').fill('framework');
  await page.getByLabel('Parameters value').fill('NEXT-READY');
  await page.getByRole('button', { name: 'Add resources', exact: true }).click();
  await page.getByLabel('Resources name').fill('checklist.md');
  await page.getByLabel('Resources value').fill('The proof code is RESOURCE-READY.');
  await saved(page);
  await page.getByText('Preview and diagnostics', { exact: true }).click();
  await choose(page, 'Evaluate for project', 'Shared guidance demo');
  const row = page.getByTestId('library-item-frontend-review');
  await expect(row).toContainText('Available');
  await row.getByText('Why? · Inspect content').click();
  await expect(row).toContainText('package.json declares dependency next');
  await page.screenshot({ path: join(results, 'global-skills.png') });
  if (process.env.LIBRARY_VISUAL_PROOF === '1') {
    const env = { ...process.env };
    delete env.ATELIER_DATA_DIR; delete env.ATELIER_PRESENTATION_MEDIA_DIR; delete env.ATELIER_PRESENTATION_EPHEMERAL;
    const capture = JSON.parse(execFileSync('atelier', ['tool', 'screen-check', 'capture', '--type', 'image', '--target', resolve(results, 'global-skills.png')], { env, encoding: 'utf8' }));
    console.log('SHARED LIBRARY VISUAL PROOF', JSON.stringify(capture));
    console.log(execFileSync('atelier', ['tool', 'present', 'compare', '--before-asset', 'fb43499c13b5de4bf5fe2bb8c61ff4474af3deb1ce659ba69fad1ee66f92ef13.png', '--after-asset', capture.captures[0].asset, '--before-alt', 'Settings before the shared library', '--after-alt', 'Shared global skills with condition evidence', '--mode', 'side_by_side'], { env, encoding: 'utf8' }));
  }

  await page.getByRole('button', { name: 'Output styles', exact: true }).click();
  await add(page, 'output style', 'concise', 'Concise', 'Use short paragraphs. When asked for library proof, include STYLE-READY.');
  await saved(page);
  await choose(page, 'Selected output style', 'Concise');
  await expect(page.getByTestId('library-item-concise')).toContainText('Available');
  await page.reload();
  await page.getByRole('button', { name: 'Output styles', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Selected output style' })).toContainText('Concise');

  await page.goto(`/project?id=${project.id}&settings=library`);
  await page.getByRole('textbox', { name: 'Project instructions', exact: true }).fill('When asked for library proof, include PROJECT-READY.');
  await page.getByRole('button', { name: 'Save project instructions' }).click();
  await expect(page.getByRole('button', { name: 'Save project instructions' })).toBeDisabled();
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByTestId('library-item-frontend-review').getByRole('button', { name: 'Customize', exact: true }).click();
  await page.getByTestId('editor-support').locator('summary').click();
  await page.getByLabel('Parameters value').fill('PROJECT-NEXT');
  await saved(page);
  await page.getByTestId('library-item-frontend-review').getByRole('switch', { name: 'Enable Frontend review for this project', exact: true }).click();
  await expect(page.getByTestId('library-item-frontend-review')).toContainText('Disabled here');
  await page.reload(); await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await expect(page.getByTestId('library-item-frontend-review')).toContainText('Disabled here');
  await page.getByTestId('library-item-frontend-review').getByRole('switch', { name: 'Enable Frontend review for this project', exact: true }).click();
  await expect(page.getByTestId('library-item-frontend-review')).toContainText('Available');
  const held = await (await request.get(`${api}?path=${encodeURIComponent(project.path)}`)).json();
  expect(held.library.overrides['frontend-review'].parameters.framework).toBe('PROJECT-NEXT');
  expect(held.guidance).toContain('GLOBAL-READY'); expect((await (await request.get(`/api/projects/${project.id}/settings`)).json()).instructions).toContain('PROJECT-READY'); expect(held.guidance).toContain('STYLE-READY');
  expect(held.guidance).not.toContain('RESOURCE-READY');
  await page.getByRole('button', { name: 'Output styles', exact: true }).click();
  await choose(page, 'Selected output style', 'No shared output style');
  await expect(page.getByTestId('library-item-concise')).toContainText('Not selected');
  await choose(page, 'Selected output style', 'Use global selection');
  await expect(page.getByTestId('library-item-concise')).toContainText('Available');
  await page.screenshot({ path: join(results, 'project-style.png') });
  writeFileSync(join(project.path, 'CLAUDE.md'), 'Keep documentation examples short.');
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByRole('button', { name: 'Import native file', exact: true }).click();
  await page.getByRole('button', { name: 'CLAUDE.md · instructions', exact: true }).click();
  await expect(page.getByLabel('Item content')).toHaveValue('Keep documentation examples short.');
  await page.getByTestId('editor-advanced').locator('summary').click();
  await page.getByLabel('Item ID').fill('imported-notes');
  await saved(page);
  expect(readFileSync(join(project.path, 'CLAUDE.md'), 'utf8')).toBe('Keep documentation examples short.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId('shared-library')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(results, 'mobile.png') });
});

test('resolver rejects stale edits, explains errors and serves immutable MCP resources', async ({ request }) => {
  const url = `${api}?path=${encodeURIComponent(project.path)}`;
  const held = await (await request.get(url)).json();
  const stale = await request.put(url, { data: { library: held.library, revision: 'stale' } });
  expect(stale.status()).toBe(422); expect(await stale.text()).toContain('another editor');
  const binary = process.env.ATELIER_BINARY || resolve('server/target/debug/atelier');
  const snap = JSON.parse(execFileSync(binary, ['tool', 'skills', 'list'], { cwd: project.path, encoding: 'utf8' }));
  const read = spawnSync(binary, ['tool', 'skills', 'mcp', snap.revision], {
    input: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'atelier_skill_read', arguments: { id: 'frontend-review' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'atelier_skill_read', arguments: { id: 'frontend-review', resource: 'checklist.md' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'atelier_skill_read', arguments: { id: 'frontend-review', resource: '../secrets' } } },
    ].map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', timeout: 10_000,
  });
  expect(read.status, read.stderr).toBe(0);
  const replies = read.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(replies[1].result.content[0].text).toContain('PROJECT-NEXT');
  expect(replies[2].result.content[0].text).toContain('RESOURCE-READY');
  expect(replies[3].result.isError).toBe(true);
  writeFileSync(join(project.path, 'package.json'), 'invalid json');
  const invalid = await (await request.get(url)).json();
  expect(invalid.resolved.items.find((r: { item: { id: string } }) => r.item.id === 'frontend-review').state).toBe('unknown');
  expect(execFileSync(binary, ['tool', 'skills', 'read', snap.revision, 'frontend-review'], { encoding: 'utf8' })).toContain('PROJECT-NEXT');
  writeFileSync(join(project.path, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }));
});

for (const brand of ['claude', 'codex']) {
  test(`real ${brand} receives shared instructions, style, slash skill and MCP resource`, async ({ page, request }) => {
    test.skip(process.env.BEADS_E2E_LIVE_PROVIDERS !== '1', 'requires isolated copied provider credentials');
    test.setTimeout(180_000);
    const made = await request.post('/api/workbench/command', { data: { type: 'session.start', brand, projectId: project.id, projectPath: project.path, permissionMode: brand === 'claude' ? 'bypassPermissions' : 'never' } });
    expect(made.ok(), await made.text()).toBeTruthy();
    const session = await made.json();
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${session.id}`);
    await expect(page.getByTestId('composer')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('composer').fill('/skill:frontend-review Give the library proof, including global, project and style markers.');
    await page.getByTestId('send-button').click();
    const messages = page.getByTestId('assistant-message');
    await expect(messages.filter({ hasText: 'RESOURCE-READY' }).last()).toBeVisible({ timeout: 120_000 });
    for (const marker of ['GLOBAL-READY', 'PROJECT-READY', 'STYLE-READY', 'PROJECT-NEXT']) await expect.poll(async () => (await messages.allTextContents()).join('\n'), { timeout: 60_000 }).toContain(marker);
    await expect(page.getByTestId('stop-button')).toBeHidden({ timeout: 60_000 });
    await expect(page.getByTestId('chat-shared-library')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('chat-shared-library')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: join(results, `${brand}-proof.png`) });
    await request.post('/api/workbench/command', { data: { type: 'session.close', sessionId: session.id } });
  });
}
