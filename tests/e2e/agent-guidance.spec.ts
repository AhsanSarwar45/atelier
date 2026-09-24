import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

test.describe.configure({ mode: 'serial' });
const results = 'tests/results/shared-library';
let project: { id: string; path: string };
test.beforeAll(async ({ request }) => {
  const run = process.env.WORKBENCH_E2E_RUN!;
  expect(run).toBeTruthy();
  mkdirSync(join(run, 'projects'), { recursive: true });
  mkdirSync(results, { recursive: true });
  const path = mkdtempSync(join(run, 'projects', 'unified-'));
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  const response = await request.post('/api/projects', { data: { name: 'Library Alpha', path } });
  expect(response.ok()).toBeTruthy(); project = await response.json();
  await request.get(`/api/projects/${project.id}/settings`);
});
test.afterAll(async ({ request }) => { if (project) await request.delete(`/api/projects/${project.id}`); });

test('one instruction destination preserves old text, global drafts, commands and project overrides', async ({ page, request }) => {
  const settingsUrl = `/api/projects/${project.id}/settings`;
  const settings = await (await request.get(settingsUrl)).json();
  expect((await request.patch(settingsUrl, { data: { ...settings.manifest, instructions: 'Existing project guidance 日本語' } })).ok()).toBeTruthy();
  await page.goto('/settings?section=library');
  await page.getByRole('textbox', { name: 'Global instructions', exact: true }).fill('Global guidance for every provider');
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await page.getByRole('button', { name: 'Instructions', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Global instructions', exact: true })).toHaveValue('Global guidance for every provider');
  await page.getByRole('button', { name: 'Save global instructions' }).click();
  await expect(page.getByRole('button', { name: 'Save global instructions' })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Global instructions', exact: true })).toHaveValue('Global guidance for every provider');
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await page.getByRole('button', { name: 'Add command', exact: true }).click();
  await page.getByLabel('Item name').fill('Release audit');
  await page.getByLabel('Item content').fill('Review {{target}} and read checklist.md');
  await expect(page.getByRole('checkbox', { name: 'Allow automatic selection by the agent' })).not.toBeChecked();
  await page.getByTestId('editor-support').locator('summary').click();
  await page.getByRole('button', { name: 'Add parameters', exact: true }).click();
  await page.getByLabel('Parameters name').fill('target');
  await page.getByLabel('Parameters value').fill('production');
  await page.getByRole('button', { name: 'Add resources', exact: true }).click();
  await page.getByLabel('Resources name').fill('checklist.md');
  await page.getByLabel('Resources value').fill('Check tests');
  await page.getByRole('button', { name: 'Save item', exact: true }).click();
  await expect(page.getByTestId('library-item-release-audit')).toBeVisible();
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await expect(page.getByTestId('library-item-release-audit')).toHaveCount(0);
  await page.goto(`/project?id=${project.id}&settings=instructions`);
  await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: /^Instructions/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Project instructions', exact: true })).toHaveValue('Existing project guidance 日本語');
  await page.getByRole('textbox', { name: 'Project instructions', exact: true }).fill('Updated project guidance');
  await page.getByRole('button', { name: 'Save project instructions' }).click();
  await expect.poll(async () => (await (await request.get(settingsUrl)).json()).instructions).toBe('Updated project guidance');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Project instructions', exact: true })).toHaveValue('Updated project guidance');
  await page.getByTestId('library-item-atelier-general-instructions').getByText('View instructions', { exact: true }).click();
  await expect(page.getByText('Global guidance for every provider', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(results, 'unified-project.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await page.getByTestId('library-item-release-audit').getByRole('button', { name: 'Customize', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Customize command', exact: true })).toBeVisible();
  await page.getByLabel('Item content').fill('Project command replacement');
  await page.getByRole('button', { name: 'Save item', exact: true }).click();
  await expect(page.getByTestId('library-item-release-audit')).toContainText('customized here');
  const resolved = await (await request.get(`/api/settings/library?path=${encodeURIComponent(project.path)}`)).json();
  expect(resolved.guidance).toContain('Global guidance for every provider');
  expect(resolved.guidance).not.toContain('Project command replacement');
  expect(resolved.resolved.items.find((r: any) => r.item.id === 'release-audit').item).toMatchObject({ automatic: false, content: 'Project command replacement', resources: { 'checklist.md': 'Check tests' } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(results, 'unified-commands-mobile.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('project rules are read-only, explain applicability and preserve older settings', async ({ page, request }) => {
  const url = `/api/settings/library?path=${encodeURIComponent(project.path)}`;
  const rule = (id: string, when = { op: 'always' } as object) => ({ id, name: id, kind: 'instruction', content: `Guidance ${id}`, when });
  const global = await (await request.get('/api/settings/library')).json();
  expect((await request.put('/api/settings/library', { data: { revision: global.revision, library: { items: [rule('applies'), rule('missing-file', { op: 'file_exists', path: 'not-here.json' }), rule('previous-override')], overrides: {} } } })).ok()).toBeTruthy();
  const local = await (await request.get(url)).json();
  expect((await request.put(url, { data: { revision: local.revision, library: { items: [rule('older-project-rule')], overrides: { 'previous-override': { content: 'Preserved customized instructions' } } } } })).ok()).toBeTruthy();
  const before = (await (await request.get(url)).json()).library;
  await page.goto(`/project?id=${project.id}&settings=library`);
  const summary = page.getByTestId('project-instruction-summary');
  await expect(summary.getByRole('heading', { name: 'Applied global guidance' })).toBeVisible();
  await expect(summary.getByTestId('library-item-applies')).toContainText('Included');
  await expect(summary.getByTestId('library-item-previous-override')).toContainText('previously saved project override');
  for (const name of ['Add instruction', 'Import native file', 'Customize', 'Edit', 'Enable here', 'Disable here', 'Reset to global', 'Remove']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Additional rules', exact: true })).toHaveCount(0);
  await summary.getByText('Not applied · 1', { exact: true }).click();
  await expect(summary.getByTestId('library-item-missing-file')).toContainText('Does not apply');
  await expect(summary.getByTestId('library-item-missing-file')).toContainText('not-here.json');
  await summary.getByText('Previously saved project rules · 1', { exact: true }).click();
  await expect(summary.getByTestId('library-item-older-project-rule')).toBeVisible();
  await page.getByRole('textbox', { name: 'Project instructions', exact: true }).fill('Only this project');
  await page.getByRole('button', { name: 'Save project instructions' }).click();
  await expect(page.getByRole('button', { name: 'Save project instructions' })).toBeDisabled();
  expect((await (await request.get(url)).json()).library).toEqual(before);
  await page.screenshot({ path: join(results, 'global-rules-readonly-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(results, 'global-rules-readonly-mobile.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await summary.getByRole('link', { name: 'Manage global instructions' }).click();
  await expect(page.getByRole('button', { name: 'Add instruction', exact: true })).toBeVisible();
  await page.getByTestId('library-item-applies').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Item content').fill('Edited globally');
  await page.getByRole('button', { name: 'Save item', exact: true }).click();
  await expect(page.getByTestId('library-editor')).toHaveCount(0);
  await page.goto(`/project?id=${project.id}&settings=library`);
  await page.getByTestId('library-item-applies').getByText('View instructions', { exact: true }).click();
  await expect(page.getByText('Edited globally', { exact: true })).toBeVisible();
  expect((await (await request.get(url)).json()).library).toEqual(before);
});

for (const brand of ['claude', 'codex'] as const) test(`${brand} chat guidance has readable groups and collapsed diagnostics`, async ({ page }) => {
  const chat = `guidance-fixture-${brand}`;
  const base = { sessionId: chat, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand, externalId: 'fixture', model: 'fixture', cwd: project.path, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'session.menu', sharedLibrary: { revision: 'diagnostic-revision-only', items: [
      { id: 'beads', name: 'Beads workflow', source: 'built-in', state: 'available', kind: 'instruction' },
      { id: 'atelier', name: 'Atelier', source: 'built-in', state: 'available', kind: 'instruction' },
      { id: 'review', name: 'Code review', source: 'global', state: 'available', kind: 'skill', automatic: true },
      { id: 'release', name: 'Release audit', source: 'project', state: 'available', kind: 'skill', automatic: false },
    ] } },
    { ...base, seq: 3, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1; static CLOSED = 3; readyState = 1;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) { if (new URL(url).searchParams.get('chat') === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }) })), 0); }
      close() { this.readyState = 3; } send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat, view: foldAll(events) });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, route => route.fulfill({ json: [{ sessionId: chat, externalId: 'fixture', brand, title: 'Guidance preview', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: project.path, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${chat}$`), route => route.fulfill({ json: { sessionId: chat, origin: 'terminal', brand, externalId: 'fixture', title: 'Guidance preview', cwd: project.path, runningElsewhere: false, held: null, beads: [] } }));
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${chat}`);
  const badge = page.getByTestId('chat-shared-library');
  await expect(badge).toBeVisible();
  if (process.env.GUIDANCE_BEFORE === '1') {
    await badge.locator(':scope > summary').click();
    await page.screenshot({ path: join(results, `active-guidance-before-${brand}.png`), animations: 'disabled' });
    return;
  }
  await expect(badge).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: join(results, `guidance-badge-${brand}.png`), animations: 'disabled' });
  await badge.click();
  const guidance = page.getByTestId('guidance-popover');
  await expect(guidance.getByText('Included in this connection · 2')).toBeVisible();
  await expect(guidance.getByText('Available on demand · 2')).toBeVisible();
  await expect(guidance.getByText('Revision diagnostic-revision-only')).not.toBeVisible();
  await expect(guidance.getByText(/Command · Project/)).toBeVisible();
  await page.screenshot({ path: join(results, `active-guidance-after-${brand}.png`), animations: 'disabled' });
  await guidance.getByText('Diagnostics', { exact: true }).click();
  await expect(guidance.getByText('Revision diagnostic-revision-only')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(guidance).not.toBeVisible();
  await expect(badge).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  const scrim = page.getByTestId('chat-right-rail-scrim');
  if (await scrim.isVisible()) await page.getByTestId('chat-right-rail-toggle').click();
  await badge.click();
  await expect(guidance).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(results, `guidance-badge-mobile-${brand}.png`), animations: 'disabled' });
});
