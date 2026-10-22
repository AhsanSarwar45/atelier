import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * Servers that come with a plugin or with claude.ai are on the MCP tab
 * (bw-xrffk.1).
 *
 * Slack reaches a chat as `plugin:design:slack`, from a plugin claude.ai syncs
 * to the account, and the tab never showed it: it read only the settings
 * files. Now such a server is listed with where it comes from and its sign-in
 * state, and a project switches it off the way `/mcp` does.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/mcp-plugin-servers.spec.ts
 */

const results = 'tests/results/mcp-plugin-servers';
const claudeDir = process.env.CLAUDE_CONFIG_DIR!;
const bucket = join(claudeDir, 'plugins/synced/e2e-bucket');
const claudeJson = join(claudeDir, '.claude.json');

function readClaudeJson(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(claudeJson, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
  // A synced `design` plugin bundling Slack, as claude.ai leaves it on disk.
  mkdirSync(join(bucket, 'design/.claude-plugin'), { recursive: true });
  writeFileSync(join(bucket, 'manifest.json'), JSON.stringify({ plugins: [{ name: 'design', version: '1.0.0' }] }));
  writeFileSync(join(bucket, 'design/.claude-plugin/plugin.json'), JSON.stringify({ name: 'design' }));
  writeFileSync(join(bucket, 'design/.mcp.json'), JSON.stringify({ mcpServers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp' } } }));
  // One claude.ai connector that has connected.
  writeFileSync(claudeJson, JSON.stringify({ ...readClaudeJson(), claudeAiMcpEverConnected: ['claude.ai Gmail'] }));
});

test.afterAll(() => {
  rmSync(bucket, { recursive: true, force: true });
});

test('Slack from a synced plugin and a claude.ai connector are listed, and a project switches Slack off', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings?section=claude&tab=mcp');
  const slack = page.getByTestId('mcp-server-plugin:design:slack');
  await expect(slack).toBeVisible();
  await expect(slack).toContainText('slack');
  await expect(page.getByTestId('mcp-source-plugin:design:slack')).toHaveText('design plugin');
  // The run carries the real account's sign-ins, which may hold Slack's.
  await expect(page.getByTestId('mcp-auth-plugin:design:slack')).toHaveText(/Signed in|Not signed in|Sign-in expired/);
  await expect(page.getByTestId('mcp-login-plugin:design:slack').or(page.getByTestId('mcp-logout-plugin:design:slack'))).toBeVisible();
  // It comes with the plugin, so there is nothing to remove here.
  await expect(page.getByTestId('mcp-remove-plugin:design:slack')).toHaveCount(0);
  const gmail = page.getByTestId('mcp-server-claude.ai Gmail');
  await expect(gmail).toContainText('Gmail');
  await expect(page.getByTestId('mcp-source-claude.ai Gmail')).toHaveText('claude.ai');
  await expect(page.getByTestId('mcp-auth-claude.ai Gmail')).toHaveText('Signed in');
  await page.screenshot({ path: join(results, 'account.png') });

  // In a project, Slack has a switch, and switching it off is what /mcp writes.
  const repo = mkdtempSync(join(tmpdir(), 'atelier-mcp-plugin-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const made = await request.post('/api/projects', { data: { name: 'mcp-plugin-servers', path: repo } });
  expect(made.status(), await made.text()).toBe(201);
  const { id } = (await made.json()) as { id: string };
  try {
    await page.goto(`/project?id=${id}&settings=claude&ptab=mcp`);
    const toggle = page.getByTestId('mcp-enabled-plugin:design:slack');
    await expect(toggle).toHaveAttribute('data-state', 'checked');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'unchecked');
    const disabled = () => {
      const projects = (readClaudeJson().projects ?? {}) as Record<string, { disabledMcpServers?: string[] }>;
      return projects[repo]?.disabledMcpServers ?? [];
    };
    await expect.poll(disabled).toContain('plugin:design:slack');
    await page.screenshot({ path: join(results, 'project-off.png') });
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'checked');
    await expect.poll(disabled).not.toContain('plugin:design:slack');
  } finally {
    await request.delete(`/api/projects/${id}`);
    rmSync(repo, { recursive: true, force: true });
  }
});
