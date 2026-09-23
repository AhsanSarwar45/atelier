import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
const api = '/api/settings/library';
const run = process.env.WORKBENCH_E2E_RUN!;
type Project = { id: string; path: string };
let alpha: Project, beta: Project;
function item(id: string, kind: string, content: string, extra = {}) {
  return { id, name: id, kind, content, description: '', when: { op: 'always' }, automatic: true, requires: [], parameters: {}, resources: {}, bundle: '', ...extra };
}
async function held(request: APIRequestContext, project?: Project) { return (await request.get(api + (project ? `?path=${encodeURIComponent(project.path)}` : ''))).json(); }
async function save(request: APIRequestContext, library: unknown, project?: Project) {
  const current = await held(request, project);
  const r = await request.put(api + (project ? `?path=${encodeURIComponent(project.path)}` : ''), { data: { library, revision: current.revision } });
  expect(r.ok(), await r.text()).toBeTruthy(); return r.json();
}
async function command(request: APIRequestContext, data: unknown) {
  const r = await request.post('/api/workbench/command', { data });
  expect(r.ok(), await r.text()).toBeTruthy(); return r.json();
}
async function edit(page: Page, id: string, inherited = false) {
  await page.getByTestId(`library-item-${id}`).getByRole('button', { name: inherited ? 'Customize' : 'Edit', exact: true }).click();
  await page.getByTestId('editor-support').locator('summary').click();
}
async function commit(page: Page) { await page.getByRole('button', { name: 'Save item', exact: true }).click(); await expect(page.getByTestId('library-editor')).toHaveCount(0); }
async function turn(page: Page, text: string) {
  const messages = page.getByTestId('assistant-message');
  const before = await messages.count() ? await messages.last().evaluate(el => el.closest('[data-transcript-key]')?.getAttribute('data-transcript-key')) : null;
  await page.getByTestId('composer').fill(text); await page.getByTestId('send-button').click();
  await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 30_000 });
  // The transcript is virtualized: a new answer can replace an old visible row
  // without increasing the number of mounted messages.
  await expect.poll(async () => await messages.count() ? messages.last().evaluate(el => el.closest('[data-transcript-key]')?.getAttribute('data-transcript-key')) : null, { timeout: 120_000 }).not.toBe(before);
  await expect(page.getByTestId('stop-button')).toBeHidden({ timeout: 120_000 });
  return (await messages.last().innerText()).trim();
}

test.beforeAll(async ({ request }) => {
  expect(run, 'Use the isolated workbench harness').toBeTruthy();
  mkdirSync(join(run, 'projects'), { recursive: true });
  const projects: Project[] = [];
  for (const name of ['Alpha edge cases', 'Beta edge cases']) {
    const path = mkdtempSync(join(run, 'projects', 'guidance-edge-'));
    execFileSync('git', ['init', '-q', '-b', 'main', path]);
    writeFileSync(join(path, 'package.json'), JSON.stringify({ dependencies: name.startsWith('Alpha') ? { next: '16' } : {}, private: true }));
    const r = await request.post('/api/projects', { data: { name, path } }); expect(r.status()).toBe(201);
    const p = await r.json(); projects.push(p); expect((await request.get(`/api/projects/${p.id}/settings`)).ok()).toBeTruthy();
  }
  [alpha, beta] = projects;
});
test.afterAll(async ({ request }) => { for (const p of [alpha, beta]) if (p) await request.delete(`/api/projects/${p.id}`); });

test('resource add/delete/rename and Unicode survive save and reload without collisions', async ({ page, request }) => {
  await save(request, { items: [item('edit-resources', 'skill', 'Read nested resources')], overrides: {} });
  await page.goto('/settings?section=library'); await page.getByRole('button', { name: 'Skills', exact: true }).click(); await edit(page, 'edit-resources');
  await page.getByRole('button', { name: 'Add resources' }).click(); await page.getByRole('button', { name: 'Add resources' }).click();
  await page.getByLabel('Resources value').nth(1).fill('KEEP 日本語 🧪');
  await page.getByRole('button', { name: 'Remove resources' }).first().click();
  await page.getByRole('button', { name: 'Add resources' }).click();
  await expect(page.getByLabel('Resources name')).toHaveCount(2);
  await expect(page.getByLabel('Resources value').first()).toHaveValue('KEEP 日本語 🧪');
  await page.getByLabel('Resources name').first().fill('references/deep/check.md');
  await commit(page); await page.reload(); await page.getByRole('button', { name: 'Skills', exact: true }).click(); await edit(page, 'edit-resources');
  expect(await page.getByLabel('Resources value').evaluateAll(fields => fields.map(field => (field as HTMLTextAreaElement).value))).toContain('KEEP 日本語 🧪');
  expect((await held(request)).library.items[0].resources['references/deep/check.md']).toBe('KEEP 日本語 🧪');
});

test('project customization resets to the actual global source and removes project-only parameters', async ({ page, request }) => {
  const original = item('inherited', 'skill', 'global {{runner}}', { parameters: { runner: 'npm test' } });
  await save(request, { items: [original], overrides: {} });
  await save(request, { items: [], overrides: { inherited: { parameters: { runner: 'cargo test', extra: 'remove me' }, content: 'project content', automatic: false } } }, alpha);
  await page.goto(`/project?id=${alpha.id}&settings=library`); await page.getByRole('button', { name: 'Commands', exact: true }).click(); await edit(page, 'inherited', true);
  await page.getByRole('button', { name: 'Reset parameters to global' }).click();
  await page.getByRole('button', { name: 'Remove parameters' }).click();
  await page.getByLabel('Item content').fill(original.content); await page.getByRole('checkbox', { name: 'Allow automatic selection by the agent' }).check();
  await commit(page);
  expect((await held(request, alpha)).library.overrides.inherited).toMatchObject({ parameters: {}, content: null, automatic: null });
  original.content = 'UPDATED GLOBAL {{runner}}'; original.parameters.runner = 'pnpm test';
  await save(request, { items: [original], overrides: {} });
  await page.reload(); await page.getByRole('button', { name: 'Skills', exact: true }).click(); await edit(page, 'inherited', true);
  await expect(page.getByLabel('Item content')).toHaveValue(original.content);
  await expect(page.getByLabel('Parameters value')).toHaveValue('pnpm test');
  expect((await held(request, beta)).library.overrides).toEqual({});
});

test('stale browser saves retain the draft, refuse overwrite, and recover on explicit reload', async ({ page, context, request }) => {
  await save(request, { items: [item('stale', 'skill', 'original')], overrides: {} });
  const other = await context.newPage();
  try {
    for (const p of [page, other]) { await p.goto('/settings?section=library'); await p.getByRole('button', { name: 'Skills', exact: true }).click(); await edit(p, 'stale'); }
    await page.getByLabel('Item content').fill('first editor'); await commit(page);
    await other.getByLabel('Item content').fill('second editor draft'); await other.getByRole('button', { name: 'Save item', exact: true }).click();
    await expect(other.getByRole('alert').filter({ hasText: 'another editor' })).toBeVisible();
    await expect(other.getByLabel('Item content')).toHaveValue('second editor draft');
    expect((await held(request)).library.items[0].content).toBe('first editor');
    await other.getByRole('button', { name: 'Discard draft and reload' }).click(); await edit(other, 'stale');
    await expect(other.getByLabel('Item content')).toHaveValue('first editor');
  } finally { await other.close(); }
});

test('project drafts cannot accidentally pin an outdated global parameter', async ({ page, request }) => {
  const source = item('changing-source', 'skill', 'Run {{runner}}', { parameters: { runner: 'npm test' } });
  await save(request, { items: [source], overrides: {} });
  await save(request, { items: [], overrides: {} }, alpha);
  await page.goto(`/project?id=${alpha.id}&settings=library`); await page.getByRole('button', { name: 'Skills', exact: true }).click(); await edit(page, source.id, true);
  await page.getByLabel('Item content').fill('My procedure {{runner}}');
  source.parameters.runner = 'pnpm test'; await save(request, { items: [source], overrides: {} });
  await page.getByRole('button', { name: 'Save item', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Global library changed' })).toBeVisible();
  await expect(page.getByLabel('Item content')).toHaveValue('My procedure {{runner}}');
  expect((await held(request, alpha)).library.overrides).toEqual({});
  await page.getByRole('button', { name: 'Discard draft and reload' }).click(); await edit(page, source.id, true);
  await expect(page.getByLabel('Parameters value')).toHaveValue('pnpm test');
});

test('conditions and unavailable requirements are explained and differ between projects', async ({ page, request }) => {
  writeFileSync(join(alpha.path, 'config.yaml'), 'enabled: true\n');
  writeFileSync(join(alpha.path, 'Cargo.toml'), '[package]\nname = "demo"\n');
  const cases = [
    ['dependency', { op: 'dependency', path: 'package.json', name: 'next' }],
    ['json', { op: 'json_equals', path: 'package.json', pointer: '/private', value: true }],
    ['toml', { op: 'toml_equals', path: 'Cargo.toml', key: 'package.name', value: 'demo' }],
    ['yaml', { op: 'yaml_equals', path: 'config.yaml', pointer: '/enabled', value: true }],
    ['nested', { op: 'all', conditions: [{ op: 'file_exists', path: 'Cargo.toml' }, { op: 'not', condition: { op: 'file_exists', path: 'missing' } }] }],
  ] as const;
  await save(request, { items: [...cases.map(([id, when]) => item(id, 'skill', 'procedure', { when })), item('missing-tool', 'skill', 'procedure', { requires: ['nonexistent-guidance-test-tool'] })], overrides: {} });
  const a = await held(request, alpha), b = await held(request, beta);
  for (const [id] of cases) expect(a.resolved.items.find((r: any) => r.item.id === id).state).toBe('available');
  for (const id of ['dependency', 'toml', 'yaml', 'nested']) expect(b.resolved.items.find((r: any) => r.item.id === id).state).toBe('not_applicable');
  expect(a.resolved.items.find((r: any) => r.item.id === 'missing-tool').state).toBe('unavailable');
  writeFileSync(join(alpha.path, 'config.yaml'), 'enabled: [broken');
  expect((await held(request, alpha)).resolved.items.find((r: any) => r.item.id === 'yaml').state).toBe('unknown');
  await page.goto(`/project?id=${alpha.id}&settings=library`); await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await expect(page.getByTestId('library-item-yaml')).toContainText('Needs evaluation');
  await expect(page.getByTestId('library-item-missing-tool')).toContainText('Missing requirements');
});

test('removing global sources exposes orphan customizations and ambiguous IDs disable only the conflict', async ({ page, request }) => {
  await save(request, { items: [item('source', 'skill', 'source')], overrides: {} });
  await save(request, { items: [item('collision', 'skill', 'local')], overrides: { source: { content: 'custom' } } }, alpha);
  await save(request, { items: [item('collision', 'skill', 'global'), item('unaffected', 'skill', 'safe')], overrides: {} });
  const result = await held(request, alpha); expect(result.orphaned).toContain('source');
  expect(result.resolved.items.find((r: any) => r.item.id === 'collision').state).toBe('conflict');
  expect(result.resolved.items.find((r: any) => r.item.id === 'unaffected').state).toBe('available');
  await page.goto(`/project?id=${alpha.id}&settings=library`); await expect(page.getByText('Global source removed:', { exact: false })).toBeVisible();
  // Remove the conflicting project source before saving the unrelated orphan cleanup.
  await save(request, { items: [], overrides: { source: { content: 'custom' } } }, alpha);
  await page.reload(); await page.getByRole('button', { name: 'Forget customization' }).click();
  await expect(page.getByRole('button', { name: 'Forget customization' })).toHaveCount(0);
});

test('global and project forms have clear sections and keep nested groups usable on mobile', async ({ page, request }) => {
  const skill = item('layout', 'skill', 'Run {{runner}}', { parameters: { runner: 'npm test' }, resources: { 'references/check.md': 'Check release notes' } });
  await save(request, { items: [skill], overrides: {} });
  await save(request, { items: [], overrides: {} }, alpha);
  for (const project of [undefined, alpha]) {
    await page.goto(project ? `/project?id=${project.id}&settings=library` : '/settings?section=library');
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await edit(page, 'layout', !!project);
    const editor = page.getByTestId('library-editor');
    await expect(editor.getByTestId('editor-section')).toHaveCount(2);
    await expect(editor.getByRole('region', { name: 'What it does' })).toBeVisible();
    await expect(editor.getByRole('region', { name: 'When it applies' })).toBeVisible();
    await expect(editor.getByTestId('editor-advanced')).not.toHaveAttribute('open');
    await expect(page.getByRole('group', { name: 'Library categories' })).toHaveCount(0);
    await expect(editor.locator('[data-slot="panel"] [data-slot="panel"]')).toHaveCount(0);
    await expect(editor).not.toHaveAttribute('data-slot', 'panel');
    await expect(page.getByTestId('condition-builder').first()).toHaveCSS('border-top-width', '0px');
    await page.getByRole('combobox', { name: 'Condition', exact: true }).first().click();
    await page.getByRole('option', { name: 'All conditions', exact: true }).click();
    await page.getByRole('button', { name: 'Add condition', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Condition', exact: true })).toHaveCount(3);
    await page.getByLabel('Condition path').first().fill('package.json');
    await page.getByRole('button', { name: 'Remove condition', exact: true }).last().click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('combobox', { name: 'Condition', exact: true }).last().scrollIntoViewIfNeeded();
      const bounds = await editor.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return [...el.querySelectorAll('input, textarea, button')].every(control => {
          const b = control.getBoundingClientRect();
          return b.width === 0 || (b.left >= rect.left - 1 && b.right <= rect.right + 1);
        });
      });
      expect(bounds, `${project ? 'project' : 'global'} controls fit at ${width}px`).toBe(true);
      await page.screenshot({ path: `tests/results/shared-library/layout-${project ? 'project' : 'global'}-${width}.png`, animations: 'disabled' });
    }
    await page.getByLabel('Parameters value').fill(project ? 'pnpm test' : 'npm run test');
    await commit(page);
    const saved = await held(request, project);
    const result = saved.resolved.items.find((row: any) => row.item.id === 'layout');
    expect(result.item.when).toMatchObject({ op: 'all', conditions: [{ op: 'file_exists', path: 'package.json' }] });
    expect(result.item.parameters.runner).toBe(project ? 'pnpm test' : 'npm run test');
  }
});

test('new guidance needs no advanced setup and explicitly chosen identifiers stay stable', async ({ page, request }) => {
  await save(request, { items: [item('release-check', 'skill', 'existing')], overrides: {} });
  await page.goto('/settings?section=library');
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByRole('button', { name: 'Add skill', exact: true }).click();
  await expect(page.getByTestId('editor-advanced')).not.toHaveAttribute('open');
  await expect(page.getByTestId('editor-support')).not.toHaveAttribute('open');
  await page.getByLabel('Item name').fill('Release check');
  await page.getByLabel('Item content').fill('Check release notes');
  await expect(page.getByText('/skill:release-check-2', { exact: true })).toBeVisible();
  await commit(page);
  expect((await held(request)).library.items.find((i: any) => i.id === 'release-check-2').content).toBe('Check release notes');
  await page.getByRole('button', { name: 'Add skill', exact: true }).click();
  await page.getByLabel('Item name').fill('Atelier review');
  await page.getByLabel('Item content').fill('Review the app');
  await expect(page.getByTestId('editor-advanced')).not.toHaveAttribute('open');
  await commit(page);
  expect((await held(request)).library.items.find((i: any) => i.id === 'my-atelier-review').content).toBe('Review the app');
  await page.getByRole('button', { name: 'Add skill', exact: true }).click();
  await page.getByTestId('editor-advanced').locator('summary').click();
  await page.getByLabel('Item ID', { exact: true }).fill('chosen-id');
  await page.getByLabel('Item name').fill('Different name');
  await expect(page.getByLabel('Item ID', { exact: true })).toHaveValue('chosen-id');
  await page.getByLabel('Item content').fill('Procedure');
  await commit(page);
  await page.getByTestId('library-item-chosen-id').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Item name').fill('Renamed');
  await commit(page);
  expect((await held(request)).library.items.find((i: any) => i.id === 'chosen-id').name).toBe('Renamed');
});

for (const brand of ['claude', 'codex']) {
  test(`${brand}: automatic nested-resource skill, actual style, pinned edits, reconnect, manual skill and isolation`, async ({ page, request }) => {
    test.skip(process.env.BEADS_E2E_LIVE_PROVIDERS !== '1', 'requires isolated provider credential copies');
    test.setTimeout(600_000);
    const globals = {
      general_instructions: 'For release readiness and manual audit reports the global field is GLOBAL-V1.',
      items: [
        item('auto-release', 'skill', 'Read references/deep/release.md with atelier_skill_read. Use project parameter {{workspace}}. Follow the selected output style.', { description: 'Use for requests to inspect release readiness.', when: { op: 'dependency', path: 'package.json', name: 'next' }, parameters: { workspace: 'BASE' }, resources: { 'references/deep/release.md': 'Report proof RELEASE-V1; project {{workspace}}; unicode 日本語 🧪. Get global and local fields from the shared instructions. Follow the selected output style.' } }),
        item('manual-audit', 'skill', 'Report proof MANUAL-V1; project {{workspace}}; unicode 日本語 🧪. Get global and local fields from shared instructions. Follow the selected output style.', { automatic: false, parameters: { workspace: 'BASE' } }),
        item('json-style', 'output_style', 'For release readiness and manual audit, final output must be ONLY one valid JSON object, no Markdown fences or extra prose. Exactly five string fields: proof, project, global, local, unicode.'),
        item('pipe-style', 'output_style', 'For release readiness and manual audit, final output must be ONLY one line: PIPE|<proof>|<project>|<global>|<local>|<unicode>. No Markdown or extra prose.'),
      ], overrides: {}, output_style: 'json-style',
    };
    await save(request, globals);
    await save(request, { items: [item('local-marker', 'instruction', 'For release readiness and manual audit the local field is ALPHA.')], overrides: { 'auto-release': { parameters: { workspace: 'ALPHA' } }, 'manual-audit': { parameters: { workspace: 'ALPHA' } } } }, alpha);
    await save(request, { items: [item('local-marker', 'instruction', 'For release readiness and manual audit the local field is BETA.')], overrides: {} }, beta);
    const sessions: string[] = [];
    const start = async (p: Project) => { const s = await command(request, { type: 'session.start', brand, projectId: p.id, projectPath: p.path, permissionMode: brand === 'claude' ? 'bypassPermissions' : 'never' }); sessions.push(s.id); await page.goto(`/project?id=${p.id}&tab=chat&chat=${s.id}`); await expect(page.getByTestId('composer')).toBeVisible(); return s; };
    const prompt = 'Inspect release readiness. Read the applicable shared skill and its nested resource now; do not reuse any previous result. Follow the selected output style.';
    try {
      const s = await start(alpha);
      expect(JSON.parse(await turn(page, prompt))).toEqual({ proof: 'RELEASE-V1', project: 'ALPHA', global: 'GLOBAL-V1', local: 'ALPHA', unicode: '日本語 🧪' });
      await page.getByTestId('chat-shared-library').locator(':scope > summary').click();
      await page.getByTestId('guidance-diagnostics').locator('summary').click();
      const pinned = await page.getByTestId('chat-shared-library').innerText();
      globals.general_instructions = 'For release readiness and manual audit reports the global field is GLOBAL-V2.';
      (globals.items[0].resources as Record<string, string>)['references/deep/release.md'] = 'Report proof RELEASE-V2; project {{workspace}}; unicode 日本語 🧪. Get global and local fields from shared instructions. Follow the selected output style.';
      globals.output_style = 'pipe-style'; await save(request, globals);
      expect(JSON.parse(await turn(page, prompt))).toEqual({ proof: 'RELEASE-V1', project: 'ALPHA', global: 'GLOBAL-V1', local: 'ALPHA', unicode: '日本語 🧪' });
      expect(await page.getByTestId('chat-shared-library').innerText()).toBe(pinned);
      const info = await (await request.get(`/api/workbench/session/${s.id}`)).json();
      await command(request, { type: 'session.close', sessionId: s.id });
      await expect.poll(async () => {
        const resumed = await request.post('/api/workbench/command', { data: { type: 'session.resume', sessionId: s.id, externalId: info.externalId, brand, projectId: alpha.id, projectPath: alpha.path } });
        if (!resumed.ok()) expect(await resumed.text()).toContain('Another program has this chat open');
        return resumed.ok();
      }, { timeout: 30_000, intervals: [500, 1000] }).toBe(true);
      await page.reload();
      expect(await turn(page, prompt)).toBe('PIPE|RELEASE-V2|ALPHA|GLOBAL-V2|ALPHA|日本語 🧪');
      await page.getByTestId('chat-shared-library').locator(':scope > summary').click();
      await page.getByTestId('guidance-diagnostics').locator('summary').click();
      expect(await page.getByTestId('chat-shared-library').innerText()).not.toBe(pinned);
      expect(await turn(page, '/skill:manual-audit Perform the manual audit.')).toBe('PIPE|MANUAL-V1|ALPHA|GLOBAL-V2|ALPHA|日本語 🧪');
      const b = await start(beta);
      const refused = await request.post('/api/workbench/command', { data: { type: 'prompt.send', sessionId: b.id, text: '/skill:auto-release inspect release readiness' } });
      expect(refused.ok()).toBe(false); expect(await refused.text()).toContain('not_applicable');
      expect(await turn(page, '/skill:manual-audit Perform the manual audit.')).toBe('PIPE|MANUAL-V1|BASE|GLOBAL-V2|BETA|日本語 🧪');
      await page.screenshot({ path: `tests/results/shared-library/${brand}-edge-proof.png`, animations: 'disabled' });
    } finally { for (const sessionId of sessions) await request.post('/api/workbench/command', { data: { type: 'session.close', sessionId } }); }
  });
}
