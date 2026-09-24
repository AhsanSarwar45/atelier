import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
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
    const global = join(locations.global.skills, 'folder-global');
    const local = join(locations.project.skills, 'folder-local');
    const put = (folder: string, name: string, bytes: string | Buffer) => {
      const path = join(folder, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes);
    };
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
      await page.goto('/settings?section=library');
      await page.getByRole('button', { name: 'Skills', exact: true }).click();
      await expect(page.getByTestId('library-item-folder-global')).toContainText('Folder-backed skill');
      await expect(page.getByTestId('library-item-folder-global').getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
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
      }
    } finally {
      if (sessionId) await request.post('/api/workbench/command', { data: { type: 'session.close', sessionId } });
      await request.delete(`/api/projects/${project.id}`);
      rmSync(global, { recursive: true, force: true });
    }
  });
}
