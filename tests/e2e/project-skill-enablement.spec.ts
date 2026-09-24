import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('project switches preserve shared and local skills across reloads', async ({ page, request }) => {
  test.setTimeout(process.env.ATELIER_BROWSER_INSPECT ? 180_000 : 120_000);
  const run = process.env.WORKBENCH_E2E_RUN!;
  const root = mkdtempSync(join(run, 'switch-project-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const project = await (await request.post('/api/projects', { data: { name: 'Project skill switches', path: root } })).json();
  await request.get(`/api/projects/${project.id}/settings`);
  const locations = JSON.parse(execFileSync(process.env.ATELIER_BINARY!, ['tool', 'skills', 'locations', '--project', root], { encoding: 'utf8' }));
  const api = '/api/settings/library';
  const projectApi = `${api}?path=${encodeURIComponent(root)}`;
  const item = (id: string, name: string, extra = {}) => ({ id, name, kind: 'skill', description: `${name} test procedure`, content: `Follow ${name}.`, ...extra });
  const globalFolder = join(locations.global.skills, 'switch-global-folder');
  const localFolder = join(locations.project.skills, 'switch-local-folder');
  for (const [folder, name] of [[globalFolder, 'Shared folder skill'], [localFolder, 'Project folder skill']]) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: A scope-specific procedure\n---\nFollow ${name}.\n`);
  }
  async function save(url: string, items: unknown[]) {
    const held = await (await request.get(url)).json();
    const response = await request.put(url, { data: { library: { ...held.library, items }, revision: held.revision, source_revision: held.source_revision } });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  await save(api, [item('switch-global-json', 'Shared text skill'), item('switch-command', 'Shared command', { automatic: false }), item('switch-missing', 'Missing tool skill', { requires: ['nonexistent-skill-qa-executable'] })]);
  await save(projectApi, [item('switch-local-json', 'Project text skill')]);
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/project?id=${project.id}&settings=library`);
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await expect(page.getByTestId('library-item-switch-global-folder')).toBeVisible();
    mkdirSync('tests/results/project-skill-enablement', { recursive: true });
    await page.screenshot({ path: `tests/results/project-skill-enablement/${process.env.ATELIER_CAPTURE_BEFORE ? 'before' : 'after'}.png`, animations: 'disabled' });
    if (process.env.ATELIER_CAPTURE_BEFORE) return;
    const globalBefore = (await (await request.get(api)).json()).library;
    const folderBefore = readFileSync(join(globalFolder, 'SKILL.md'), 'utf8');
    const customRow = page.getByTestId('library-item-switch-global-json');
    await customRow.getByRole('button', { name: 'Customize', exact: true }).click();
    await page.getByLabel('Item content', { exact: true }).fill('Keep this project customization.');
    await page.getByRole('button', { name: 'Save item', exact: true }).click();
    for (const [id, name] of [['switch-global-folder', 'Shared folder skill'], ['switch-global-json', 'Shared text skill'], ['switch-local-folder', 'Project folder skill'], ['switch-local-json', 'Project text skill']]) {
      const row = page.getByTestId(`library-item-${id}`);
      const toggle = row.getByRole('switch', { name: `Enable ${name} for this project` });
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await page.reload();
      await page.getByRole('button', { name: 'Skills', exact: true }).click();
      await expect(toggle).not.toBeChecked();
      const held = await (await request.get(projectApi)).json();
      expect(held.resolved.items.find((r: { item: { id: string } }) => r.item.id === id).state).toBe('disabled');
      await toggle.focus();
      await page.keyboard.press('Space');
      await expect(toggle).toBeChecked();
    }
    expect((await (await request.get(projectApi)).json()).library.overrides['switch-global-json'].content).toBe('Keep this project customization.');
    const missing = page.getByRole('switch', { name: 'Enable Missing tool skill for this project' });
    await expect(missing).toBeChecked();
    await missing.click();
    await expect(missing).not.toBeChecked();
    await missing.click();
    await expect(missing).toBeChecked();
    expect((await (await request.get(projectApi)).json()).resolved.items.find((r: { item: { id: string } }) => r.item.id === 'switch-missing').state).toBe('unavailable');
    // Another writer changes the library after this screen loaded: do not silently overwrite it.
    const held = await (await request.get(projectApi)).json();
    held.library.overrides['switch-global-json'].content = 'Newer external customization.';
    expect((await request.put(projectApi, { data: { library: held.library, revision: held.revision, source_revision: held.source_revision } })).ok()).toBeTruthy();
    await customRow.getByRole('switch').click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect((await (await request.get(projectApi)).json()).library.overrides['switch-global-json'].content).toBe('Newer external customization.');
    await page.reload();
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await customRow.getByRole('button', { name: 'Reset to global', exact: true }).click();
    await expect(customRow.getByRole('button', { name: 'Reset to global', exact: true })).toHaveCount(0);
    expect((await (await request.get(projectApi)).json()).library.overrides['switch-global-json']).toBeUndefined();
    for (const [width, height] of [[390, 844], [768, 1024], [1024, 768], [1280, 800], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await expect(page.getByRole('switch', { name: 'Enable Shared text skill for this project' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      await page.screenshot({ path: `tests/results/project-skill-enablement/after-${width}.png`, animations: 'disabled' });
    }
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    const command = page.getByRole('switch', { name: 'Enable Shared command for this project' });
    await command.click();
    await expect(command).not.toBeChecked();
    await page.reload();
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    await expect(command).not.toBeChecked();
    expect((await (await request.get(api)).json()).library).toEqual(globalBefore);
    expect(readFileSync(join(globalFolder, 'SKILL.md'), 'utf8')).toBe(folderBefore);
    const other = mkdtempSync(join(run, 'switch-other-'));
    execFileSync('git', ['init', '-q', '-b', 'main', other]);
    const otherProject = await (await request.post('/api/projects', { data: { name: 'Other project', path: other } })).json();
    await request.get(`/api/projects/${otherProject.id}/settings`);
    try {
      const otherState = await (await request.get(`${api}?path=${encodeURIComponent(other)}`)).json();
      expect(otherState.resolved.items.find((r: { item: { id: string } }) => r.item.id === 'switch-command').state).toBe('available');
      expect(otherState.library.overrides).toEqual({});
    } finally { await request.delete(`/api/projects/${otherProject.id}`); rmSync(other, { recursive: true, force: true }); }
    if (process.env.ATELIER_BROWSER_INSPECT) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByRole('button', { name: 'Skills', exact: true }).click();
      console.log('SKILL_SWITCH_INSPECT_URL', page.url());
      await page.waitForTimeout(60_000);
    }
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(globalFolder, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrated project guidance is discovered without native provider files', async ({ page, request }) => {
  test.skip(!!process.env.ATELIER_CAPTURE_BEFORE);
  const root = mkdtempSync(join(process.env.WORKBENCH_E2E_RUN!, 'migration-project-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  mkdirSync(join(root, '.atelier'), { recursive: true });
  writeFileSync(join(root, '.atelier/project.toml'), 'schema_version = 1\n[project]\ndisplay_name = "Migrated project guidance"\n');
  cpSync('.atelier/instructions.md', join(root, '.atelier/instructions.md'));
  cpSync('.atelier/skills', join(root, '.atelier/skills'), { recursive: true });
  const project = await (await request.post('/api/projects', { data: { name: 'Migrated project guidance', path: root } })).json();
  try {
    const instructions = readFileSync('.atelier/instructions.md', 'utf8').trim();
    const settings = await (await request.get(`/api/projects/${project.id}/settings`)).json();
    expect(settings.instructions).toBe(instructions);
    for (const native of ['AGENTS.md', 'CLAUDE.md', '.agents', '.claude', '.codex']) expect(existsSync(join(root, native))).toBe(false);
    const held = await (await request.get(`/api/settings/library?path=${encodeURIComponent(root)}`)).json();
    const beads = held.resolved.items.find((row: { item: { id: string } }) => row.item.id === 'beads');
    expect(beads.source).toBe('project');
    expect(beads.state).toBe('available');
    expect(beads.item.content).toContain('Beads');
    expect(readFileSync(join(root, '.atelier/skills/beads/agents/openai.yaml'), 'utf8')).toBe(readFileSync('.atelier/skills/beads/agents/openai.yaml', 'utf8'));
    await page.goto(`/project?id=${project.id}&settings=library`);
    await expect(page.getByRole('textbox', { name: 'Project instructions', exact: true })).toHaveValue(instructions);
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await expect(page.getByTestId('library-item-beads')).toContainText('Available');
    await expect(page.getByTestId('library-item-beads').getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await page.screenshot({ path: 'tests/results/project-skill-enablement/migrated-project.png', animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(root, { recursive: true, force: true });
  }
});
