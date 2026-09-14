import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * MCP servers and extensions are managed from the provider tabs, for an
 * account and for a project, and land in the provider's own files
 * (bw-2t1c.6, bw-2t1c.8).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/mcp-extensions.spec.ts
 */

const results = 'tests/results/mcp-extensions';
const claudeDir = process.env.CLAUDE_CONFIG_DIR!;
const codexHome = process.env.CODEX_HOME!;

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

async function project(request: Parameters<Parameters<typeof test>[1]>[0]['request'], name: string) {
  const repo = mkdtempSync(join(tmpdir(), 'atelier-mcp-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const made = await request.post('/api/projects', { data: { name, path: repo } });
  expect(made.status(), await made.text()).toBe(201);
  const { id } = (await made.json()) as { id: string };
  return { id, repo };
}

test('a Claude Code account server is added, listed and removed in .claude.json', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings?section=claude&tab=mcp');
  await expect(page.getByTestId('mcp-servers-claude')).toBeVisible();
  const add = async () => {
    await page.getByTestId('mcp-add').click();
    await page.getByTestId('mcp-add-id').fill('memory');
    await page.getByTestId('mcp-add-command').fill('npx -y @modelcontextprotocol/server-memory');
    await page.getByTestId('mcp-add-submit').click();
    await expect(page.getByTestId('mcp-server-memory')).toBeVisible();
    await expect(page.getByTestId('mcp-server-memory')).toContainText('stdio');
  };
  await add();
  const file = join(claudeDir, '.claude.json');
  const inFile = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).mcpServers?.memory : undefined);
  // A `claude` the app ran to list sessions writes .claude.json back from its
  // own memory when it exits, dropping a server added meanwhile; add it again.
  await expect.poll(async () => {
    if (inFile()) return true;
    await page.reload();
    await expect(page.getByTestId('mcp-add')).toBeVisible();
    if ((await page.getByTestId('mcp-server-memory').count()) === 0) await add();
    return Boolean(inFile());
  }, { timeout: 30_000 }).toBe(true);
  const server = inFile();
  expect(server.command).toBe('npx');
  expect(server.args).toEqual(['-y', '@modelcontextprotocol/server-memory']);
  await page.screenshot({ path: join(results, 'desktop-claude-mcp.png') });

  await page.getByTestId('mcp-remove-memory').click();
  await expect(page.getByTestId('mcp-server-memory')).toHaveCount(0);
  // …and the same rewrite can put a removed server back; remove it again.
  await expect.poll(async () => {
    if (!inFile()) return true;
    await page.reload();
    await expect(page.getByTestId('mcp-add')).toBeVisible();
    if ((await page.getByTestId('mcp-server-memory').count()) > 0) {
      await page.getByTestId('mcp-remove-memory').click();
      await expect(page.getByTestId('mcp-server-memory')).toHaveCount(0);
    }
    return !inFile();
  }, { timeout: 30_000 }).toBe(true);
});

test('a remote Claude Code server says whether the CLI holds a sign-in for it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // What `claude mcp` leaves behind after an OAuth sign-in, for one of two servers.
  writeFileSync(
    join(claudeDir, '.credentials.json'),
    JSON.stringify({ mcpOAuth: { 'linear|0000000000000000': { serverName: 'linear', serverUrl: 'https://mcp.linear.test/mcp', accessToken: 'x', refreshToken: 'y', clientId: 'c' } } }),
  );
  await page.goto('/settings?section=claude&tab=mcp');
  const names = ['linear', 'notion'];
  const add = async (name: string) => {
    await page.getByTestId('mcp-add').click();
    await page.getByTestId('mcp-add-id').fill(name);
    await page.getByRole('combobox', { name: 'Kind' }).click();
    await page.getByRole('option', { name: 'URL' }).click();
    await page.getByTestId('mcp-add-url').fill(`https://mcp.${name}.test/mcp`);
    await page.getByTestId('mcp-add-submit').click();
    await expect(page.getByTestId(`mcp-server-${name}`)).toBeVisible();
  };
  for (const name of names) await add(name);
  // A `claude` the app ran to list sessions writes .claude.json back from its
  // own memory when it exits, dropping a server added meanwhile. Put back
  // whatever it dropped until a fresh read shows both.
  await expect.poll(async () => {
    await page.reload();
    await expect(page.getByTestId('mcp-add')).toBeVisible();
    const missing: string[] = [];
    for (const name of names) if ((await page.getByTestId(`mcp-server-${name}`).count()) === 0) missing.push(name);
    for (const name of missing) await add(name);
    return missing.length;
  }, { timeout: 30_000 }).toBe(0);
  await expect(page.getByTestId('mcp-auth-linear')).toHaveText('Signed in');
  await expect(page.getByTestId('mcp-logout-linear')).toBeVisible();
  await expect(page.getByTestId('mcp-auth-notion')).toHaveText('Not signed in');
  await expect(page.getByTestId('mcp-login-notion')).toBeVisible();
  await page.screenshot({ path: join(results, 'desktop-claude-signin.png') });
  for (const name of ['linear', 'notion']) await page.getByTestId(`mcp-remove-${name}`).click();
  rmSync(join(claudeDir, '.credentials.json'), { force: true });
});

test('a Codex account server is added as a URL and switched off in config.toml', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings?section=codex&tab=mcp');
  await expect(page.getByTestId('mcp-servers-codex')).toBeVisible();
  await page.getByTestId('mcp-add').click();
  await page.getByTestId('mcp-add-id').fill('docs');
  await page.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: 'URL' }).click();
  await page.getByTestId('mcp-add-url').fill('https://example.test/mcp');
  await page.getByTestId('mcp-add-submit').click();
  await expect(page.getByTestId('mcp-server-docs')).toBeVisible();
  const file = join(codexHome, 'config.toml');
  await expect.poll(() => existsSync(file) && /\[mcp_servers\.docs\]/.test(readFileSync(file, 'utf8'))).toBe(true);
  expect(readFileSync(file, 'utf8')).toContain('url = "https://example.test/mcp"');

  await page.getByTestId('mcp-enabled-docs').click();
  await expect.poll(() => /enabled = false/.test(readFileSync(file, 'utf8'))).toBe(true);
  await expect(page.getByTestId('mcp-enabled-docs')).toHaveAttribute('data-state', 'unchecked');
  await page.screenshot({ path: join(results, 'phone-codex-mcp.png'), fullPage: true });
});

test('a project lists its .mcp.json servers and its extensions', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { id, repo } = await project(request, 'With tools');
  try {
    mkdirSync(join(repo, '.claude', 'skills', 'deploy'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\n');
    mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reads diffs\n---\n');

    await page.goto(`/project?id=${id}&settings=claude&ptab=mcp`);
    await expect(page.getByTestId('mcp-servers-claude')).toBeVisible();
    await page.getByTestId('mcp-add').click();
    await page.getByTestId('mcp-add-id').fill('fs');
    await page.getByTestId('mcp-add-command').fill('npx -y @modelcontextprotocol/server-filesystem .');
    await page.getByTestId('mcp-add-submit').click();
    await expect(page.getByTestId('mcp-server-fs')).toBeVisible();
    await expect(page.getByTestId('mcp-server-fs')).toContainText('Project');
    await expect.poll(() => existsSync(join(repo, '.mcp.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8')).mcpServers.fs.command).toBe('npx');

    await page.getByTestId('provider-tab-plugins').click();
    await expect(page).toHaveURL(/ptab=plugins/);
    await expect(page.getByTestId('extensions-claude')).toBeVisible();
    await expect(page.getByTestId('extensions-plugins')).toBeVisible();
    await expect(page.getByTestId('extensions-marketplaces')).toBeVisible();
    // Skills and agents are files, so they are not here…
    await expect(page.getByText('Ship it')).toHaveCount(0);
    await expect(page.getByTestId('provider-tab-plugins')).toHaveAttribute('data-state', 'active');
    await page.screenshot({ path: join(results, 'desktop-project-plugins.png') });

    // …but under Agent files.
    await page.getByTestId('settings-section-files').click();
    await expect(page.getByTestId('agent-file-SKILL.md').first()).toBeVisible();
    await expect(page.getByTestId('agent-file-reviewer.md').first()).toBeVisible();
    await page.screenshot({ path: join(results, 'desktop-project-files.png') });

    // Codex has no plugins, so no such tab.
    await page.getByTestId('settings-section-codex').click();
    await expect(page.getByTestId('provider-tab-mcp')).toBeVisible();
    await expect(page.getByTestId('provider-tab-plugins')).toHaveCount(0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
