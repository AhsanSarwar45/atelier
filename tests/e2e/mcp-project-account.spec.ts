import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * A project's MCP servers are shown as the chats there get them (bw-yv9bi.1).
 *
 * A chat runs on one account, and that account's own files decide what it
 * loads: its `.claude.json` holds the folder's trust and local servers, and its
 * credentials hold the sign-ins. The tab used to read the system account's
 * files whatever the chat ran on, count an approval Claude ignores in an
 * untrusted folder, and list one name twice. Now it opens on the account new
 * chats use, says "Not yet approved" until Claude would load the server, and
 * switching the server on trusts the folder for that account.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/mcp-project-account.spec.ts
 */

const results = 'tests/results/mcp-project-account';
const claudeDir = process.env.CLAUDE_CONFIG_DIR!;
const dataDir = process.env.ATELIER_DATA_DIR!;

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('the project tab shows the chat account, approves for real and lists one row per name', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const made = await request.post('/api/workbench/command', { data: { type: 'profile.create', brand: 'claude', name: 'Chats here' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const profile = ((await made.json()) as { profile: { id: string } }).profile.id;
  const starred = await request.put('/api/settings/new-chat', { data: { set: 'profile', brand: 'claude', profile } });
  expect(starred.ok(), await starred.text()).toBeTruthy();
  const profileDir = join(dataDir, 'profiles', 'claude', profile);

  const repo = mkdtempSync(join(tmpdir(), 'atelier-mcp-account-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } } }));
    // The approval Claude's own prompt writes, in a folder the chat account never trusted.
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    // The system account has its own copy of the server for this folder.
    const systemFile = join(claudeDir, '.claude.json');
    const system = existsSync(systemFile) ? read(systemFile) : {};
    system.projects = { ...(system.projects ?? {}), [repo]: { hasTrustDialogAccepted: true, mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } } } };
    writeFileSync(systemFile, JSON.stringify(system));
    // Only the chat account is signed in to it.
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, '.credentials.json'),
      JSON.stringify({ mcpOAuth: { 'sentry|0000000000000000': { serverName: 'sentry', serverUrl: 'https://mcp.sentry.dev/mcp', accessToken: 'test-token', refreshToken: 'test-refresh', expiresAt: Date.now() + 86_400_000 } } }),
    );
    const add = await request.post('/api/projects', { data: { name: 'Sentry here', path: repo } });
    expect(add.status(), await add.text()).toBe(201);
    const { id } = (await add.json()) as { id: string };

    await page.goto(`/project?id=${id}&settings=claude&ptab=mcp`);
    const picker = page.getByTestId('account-picker-claude');
    await expect(picker).toContainText('Chats here');
    const row = page.getByTestId('mcp-server-sentry');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Not yet approved');
    await expect(row).toContainText('Signed in');
    await expect(page.getByTestId('mcp-enabled-sentry')).toHaveAttribute('data-state', 'unchecked');
    await page.screenshot({ path: join(results, 'before-approve.png') });

    await page.getByTestId('mcp-enabled-sentry').click();
    await expect(page.getByTestId('mcp-enabled-sentry')).toHaveAttribute('data-state', 'checked');
    await expect(row).not.toContainText('Not yet approved');
    expect(read(join(profileDir, '.claude.json')).projects[repo].hasTrustDialogAccepted).toBe(true);
    await page.screenshot({ path: join(results, 'after-approve.png') });

    // Claude itself now loads it for that account instead of holding it for approval.
    const listed = execFileSync('claude', ['mcp', 'list'], { cwd: repo, env: { ...process.env, CLAUDE_CONFIG_DIR: profileDir }, encoding: 'utf8', timeout: 90_000 });
    expect(listed).toMatch(/^sentry: /m);
    expect(listed).not.toMatch(/sentry:.*Pending approval/);

    // On the system account the local copy wins, so it is the only row.
    await picker.click();
    await page.getByRole('option', { name: 'System' }).click();
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Project, this computer');
    await expect(row).toContainText('Not signed in');
    await page.screenshot({ path: join(results, 'system-account.png') });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
