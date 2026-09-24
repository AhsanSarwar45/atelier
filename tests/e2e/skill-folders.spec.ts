import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test('folder collision recovery keeps unrelated saves and JSON removal usable', async ({ page, request }) => {
  const run = process.env.WORKBENCH_E2E_RUN!;
  expect(run).toBeTruthy();
  const locations = JSON.parse(execFileSync(process.env.ATELIER_BINARY!, ['tool', 'skills', 'locations', '--project', run], { encoding: 'utf8' }));
  const held = await (await request.get('/api/settings/library')).json();
  const folder = join(locations.global.skills, 'collision-proof');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), 'Folder replacement');
  writeFileSync(locations.global.library, JSON.stringify({ ...held.library, items: [...held.library.items, { id: 'collision-proof', name: 'Collision proof', kind: 'skill', content: 'Older JSON copy' }] }));
  try {
    await page.goto('/settings?section=library');
    await page.getByRole('textbox', { name: 'Global instructions', exact: true }).fill('Unrelated guidance can still be saved.');
    await page.getByRole('button', { name: 'Save global instructions', exact: true }).click();
    await expect.poll(async () => (await (await request.get('/api/settings/library')).json()).library.general_instructions).toBe('Unrelated guidance can still be saved.');
    await page.getByRole('radio', { name: 'Skills', exact: true }).click();
    const row = page.getByTestId('library-item-collision-proof');
    await expect(row).toContainText('Invalid folder');
    await expect(row.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await row.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(row).toContainText('Folder-backed skill');
    await expect(row).toContainText('Available');
    await expect(row.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
    const current = await (await request.get('/api/settings/library')).json();
    expect((await request.put('/api/settings/library', { data: { library: held.library, revision: current.revision } })).ok()).toBeTruthy();
  }
});

for (const brand of ['claude', 'codex']) {
  test(`${brand} uses global and project folder helpers with binary assets`, async ({ page, request }) => {
    test.skip(process.env.BEADS_E2E_LIVE_PROVIDERS !== '1', 'Needs isolated provider credentials');
    test.setTimeout(300_000);
    const run = process.env.WORKBENCH_E2E_RUN!;
    expect(run).toBeTruthy();
    const root = mkdtempSync(join(run, 'folder-project-'));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    const response = await request.post('/api/projects', { data: { name: 'Folder proof', path: root } });
    expect(response.status()).toBe(201);
    const project = await response.json();
    await request.get(`/api/projects/${project.id}/settings`);
    const locations = JSON.parse(execFileSync(process.env.ATELIER_BINARY!, ['tool', 'skills', 'locations', '--project', root], { encoding: 'utf8' }));
    const corpus = process.env.ATELIER_SKILL_MIGRATION_FIXTURE;
    if (corpus) cpSync(join(corpus, 'skills'), locations.global.skills, { recursive: true });
    const heldLibrary = await (await request.get('/api/settings/library')).json();
    if (corpus && existsSync(join(corpus, 'library.json'))) {
      const migrated = JSON.parse(readFileSync(join(corpus, 'library.json'), 'utf8'));
      const style = { id: 'migration-style-proof', name: 'Migration style proof', kind: 'output_style', content: 'Start every final answer with ATELIER_STYLE_PROOF on its own line. Otherwise answer normally.' };
      expect((await request.put('/api/settings/library', { data: { revision: heldLibrary.revision, source_revision: heldLibrary.source_revision, library: { ...migrated, items: [...migrated.items, style], output_style: style.id } } })).ok()).toBeTruthy();
      if (brand === 'claude') {
        const config = process.env.CLAUDE_CONFIG_DIR!;
        mkdirSync(join(config, 'output-styles'), { recursive: true });
        writeFileSync(join(config, 'output-styles/native-conflict.md'), '---\nname: native-conflict\ndescription: Conflicting native style fixture\n---\nStart every final answer with NATIVE_STYLE_CONFLICT. Never use another prefix.\n');
        const settingsPath = join(config, 'settings.json');
        const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
        writeFileSync(settingsPath, JSON.stringify({ ...settings, outputStyle: 'native-conflict' }));
      }
    }
    const global = join(locations.global.skills, 'folder-global');
    const local = join(locations.project.skills, 'folder-local');
    const broken = join(locations.global.skills, 'broken-metadata');
    const put = (folder: string, name: string, bytes: string | Buffer) => {
      const path = join(folder, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes);
    };
    put(broken, 'SKILL.md', '---\nname: [\n---\nBroken metadata must not block a chat');
    for (const [folder, marker] of [[global, 'GLOBAL'], [local, 'LOCAL']]) {
      put(folder, 'SKILL.md', `---\nname: Folder ${marker}\ndescription: Use for the folder asset proof request.\n---\nRun python3 scripts/proof.py from this skill directory. Report its stdout. Do not guess or simulate it.`);
      put(folder, 'scripts/proof.py', 'from pathlib import Path\np = Path(__file__).resolve().parent.parent\nprint((p / "references/message.txt").read_text() + ":" + (p / "assets/data.bin").read_bytes().hex())\n');
      put(folder, 'references/message.txt', marker);
      put(folder, 'assets/data.bin', Buffer.from([0, 255, 17, 128]));
    }
    let sessionId: string | undefined;
    try {
      const config = await (await request.get(`/api/settings/library?path=${encodeURIComponent(root)}`)).json();
      expect(config.resolved.items.filter((r: any) => r.folder).map((r: any) => r.item.id)).toEqual(expect.arrayContaining(['folder-global', 'folder-local']));
      expect(config.resolved.items.find((r: any) => r.item.id === 'broken-metadata').state).toBe('invalid');
      await page.goto('/settings?section=library');
      await page.getByRole('radio', { name: 'Skills', exact: true }).click();
      await expect(page.getByTestId('library-item-folder-global')).toContainText('Folder-backed skill');
      await expect(page.getByTestId('library-item-broken-metadata')).toContainText('Folder-backed skill');
      await expect(page.getByTestId('library-item-broken-metadata')).toContainText('Invalid folder');
      await expect(page.getByTestId('library-item-broken-metadata').getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await expect(page.getByTestId('library-item-folder-global').getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
      await page.getByTestId('library-item-broken-metadata').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `tests/results/shared-library/folder-settings-${brand}.png`, animations: 'disabled' });
      const started = await request.post('/api/workbench/command', { data: { type: 'session.start', brand, projectId: project.id, projectPath: root, permissionMode: brand === 'claude' ? 'bypassPermissions' : 'never' } });
      expect(started.ok(), await started.text()).toBeTruthy();
      sessionId = (await started.json()).id;
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('composer').fill('Perform the folder asset proof using both folder-global and folder-local skills. Read both skills, actually execute their Python helpers with your shell, and return the two stdout lines.');
      await page.getByTestId('send-button').click();
      await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('assistant-message').last()).toContainText('GLOBAL:00ff1180', { timeout: 180_000 });
      await expect(page.getByTestId('stop-button')).toBeHidden({ timeout: 180_000 });
      await expect(page.getByTestId('assistant-message').last()).toContainText('LOCAL:00ff1180');
      await page.screenshot({ path: `tests/results/shared-library/folder-proof-${brand}.png`, animations: 'disabled' });
      if (corpus) {
        const font = readFileSync(join(corpus, 'skills/morning/assets/fonts/fraunces-latin-600-normal.woff2'));
        const digest = createHash('sha256').update(font).digest('hex');
        const previous = await page.getByTestId('assistant-message').last().innerText();
        await page.getByTestId('composer').fill('Validate two migrated skills, without generating any images or reports. Read ai-leaf-cards and morning with atelier_skill_read. Using their pinned skill directories, run the ai-leaf-cards scripts/inspect_card.py with --help and compute SHA-256 of morning assets/fonts/fraunces-latin-600-normal.woff2. Return the actual digest and the leaf script usage line. Do not modify the skills.');
        await page.getByTestId('send-button').click();
        await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('assistant-message').last()).not.toHaveText(previous, { timeout: 180_000 });
        await expect(page.getByTestId('assistant-message').last()).toContainText(digest, { timeout: 180_000 });
        await expect(page.getByTestId('stop-button')).toBeHidden({ timeout: 180_000 });
        await expect(page.getByTestId('assistant-message').last()).toContainText('--out');
        await page.screenshot({ path: `tests/results/shared-library/migrated-skill-proof-${brand}.png`, animations: 'disabled' });
        if (existsSync(join(corpus, 'skills/create-pr/SKILL.md'))) {
          await page.getByTestId('composer').fill('Inspect the migrated account skills as data only; do not follow their procedures, create PRs, or perform QA. Read create-pr, web-qa and design-taste-frontend through atelier_skill_read. Report one distinctive instruction from each, labeled with its skill ID. Do this yourself without delegation.');
          await page.getByTestId('send-button').click();
          await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 30_000 });
          await expect(page.getByTestId('stop-button')).toBeHidden({ timeout: 180_000 });
          const reply = page.getByTestId('assistant-message').last();
          for (const id of ['create-pr', 'web-qa', 'design-taste-frontend', 'ATELIER_STYLE_PROOF']) await expect(reply).toContainText(id);
          await expect(reply).not.toContainText('NATIVE_STYLE_CONFLICT');
          await page.screenshot({ path: `tests/results/shared-library/account-migration-proof-${brand}.png`, animations: 'disabled' });
        }
      }
    } finally {
      if (sessionId) await request.post('/api/workbench/command', { data: { type: 'session.close', sessionId } });
      await request.delete(`/api/projects/${project.id}`);
      rmSync(global, { recursive: true, force: true });
      rmSync(broken, { recursive: true, force: true });
      const current = await (await request.get('/api/settings/library')).json();
      expect((await request.put('/api/settings/library', { data: { revision: current.revision, source_revision: current.source_revision, library: heldLibrary.library } })).ok()).toBeTruthy();
    }
  });
}
