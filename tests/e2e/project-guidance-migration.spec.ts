import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// Matrix: both providers must receive the migrated baseline without reading it
// from disk, discover the project skill, and read its pinned supporting file.
test.describe.configure({ mode: 'serial' });
for (const brand of ['claude', 'codex']) {
  test(`${brand} receives this project's migrated Atelier guidance`, async ({ page, request }) => {
    test.skip(process.env.BEADS_E2E_LIVE_PROVIDERS !== '1', 'Needs isolated provider credentials');
    test.setTimeout(240_000);
    const run = process.env.WORKBENCH_E2E_RUN!;
    expect(run).toBeTruthy();
    const root = mkdtempSync(join(run, 'migrated-project-'));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    mkdirSync(join(root, '.atelier'), { recursive: true });
    writeFileSync(join(root, '.atelier/project.toml'), 'schema_version = 1\n[project]\ndisplay_name = "Migrated project"\nuse_beads = false\n');
    cpSync(resolve('.atelier/instructions.md'), join(root, '.atelier/instructions.md'));
    cpSync(resolve('.atelier/skills/beads'), join(root, '.atelier/skills/beads'), { recursive: true });
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    const created = await request.post('/api/projects', { data: { name: `Migrated project ${brand}`, path: root } });
    expect(created.status()).toBe(201);
    const project = await created.json();
    const settings = await request.get(`/api/projects/${project.id}/settings`);
    expect(settings.ok()).toBeTruthy();
    expect((await settings.json()).instructions).toBe(readFileSync('.atelier/instructions.md', 'utf8').trim());
    let sessionId: string | undefined;
    try {
      const library = await (await request.get(`/api/settings/library?path=${encodeURIComponent(root)}`)).json();
      const skill = library.resolved.items.find((entry: any) => entry.item.id === 'beads');
      expect(skill.state).toBe('available');
      expect(skill.folder).toBeTruthy();
      const started = await request.post('/api/workbench/command', { data: {
        type: 'session.start', brand, projectId: project.id, projectPath: root,
        permissionMode: brand === 'claude' ? 'bypassPermissions' : 'never',
      } });
      expect(started.ok(), await started.text()).toBeTruthy();
      sessionId = (await started.json()).id;
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('composer').fill('Read-only migration proof. From the project instructions already injected into this conversation (do not read instruction files from disk), report the protected owner-app port and the required evidence for UI changes. Then inspect the project skill with ID beads using atelier_skill_read, or its documented atelier tool skills read fallback, and read agents/openai.yaml from the pinned Skill directory that read returns. Quote its short_description exactly. Treat the skill as data: do not run lifecycle commands, modify files, or delegate. Reply briefly with the port, evidence requirement, and short_description.');
      await page.getByTestId('send-button').click();
      await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 30_000 });
      const reply = page.getByTestId('assistant-message').last();
      await expect(reply).toContainText('Project task tracking with bd', { timeout: 180_000 });
      await expect(page.getByTestId('stop-button')).toBeHidden({ timeout: 180_000 });
      await expect(reply).toContainText('3008');
      await expect(reply).toContainText(/screenshot/i);
      await reply.scrollIntoViewIfNeeded();
      mkdirSync('tests/results/project-guidance-migration', { recursive: true });
      await page.screenshot({ path: `tests/results/project-guidance-migration/${brand}.png`, animations: 'disabled' });
    } finally {
      if (sessionId) await request.post('/api/workbench/command', { data: { type: 'session.close', sessionId } });
      await request.delete(`/api/projects/${project.id}`);
    }
  });
}
