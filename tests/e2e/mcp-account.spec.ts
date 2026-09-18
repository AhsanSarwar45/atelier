import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * A server belongs to the account it was added on, and the panel says where
 * the others are (bw-6ecp.2).
 *
 * Each account keeps its own servers — the system account in the directory the
 * server booted with, every other in its own profile directory — and a chat is
 * launched pointed at that account's directory, so the agent loads that
 * account's servers and no others. That much was already true, and invisible:
 * a server added on one account was simply absent on the next, with nothing on
 * the screen to say where it had gone. Now the panel names them, and one click
 * puts one where it is wanted.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/mcp-account.spec.ts
 */

const results = 'tests/results/mcp-account';
const claudeDir = process.env.CLAUDE_CONFIG_DIR!;
const dataDir = process.env.ATELIER_DATA_DIR!;

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

/** The servers in one account's own file — the file a chat on it is pointed at. */
const servers = (file: string): Record<string, { command?: string }> =>
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {}) : {};

test('a server on one account is named on another, and one click puts it there', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // A second Claude account, made without the sign-in that follows adding one on screen.
  const made = await request.post('/api/workbench/command', { data: { type: 'profile.create', brand: 'claude', name: 'Work' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const id = ((await made.json()) as { profile: { id: string } }).profile.id;

  // A server on the System account.
  await page.goto('/settings?section=claude&tab=mcp');
  await expect(page.getByTestId('mcp-servers-claude')).toBeVisible();
  const add = async () => {
    await page.getByTestId('mcp-add').click();
    await page.getByTestId('mcp-add-id').fill('memory');
    await page.getByTestId('mcp-add-command').fill('npx -y @modelcontextprotocol/server-memory');
    await page.getByTestId('mcp-add-submit').click();
    await expect(page.getByTestId('mcp-server-memory')).toBeVisible();
  };
  await add();
  const systemFile = join(claudeDir, '.claude.json');
  // A `claude` the app ran to list sessions writes .claude.json back from its
  // own memory when it exits, dropping a server added meanwhile; add it again.
  await expect
    .poll(
      async () => {
        if (servers(systemFile).memory) return true;
        await page.reload();
        await expect(page.getByTestId('mcp-add')).toBeVisible();
        if ((await page.getByTestId('mcp-server-memory').count()) === 0) await add();
        return Boolean(servers(systemFile).memory);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  // The account that has it is not told about it.
  await expect(page.getByTestId('mcp-elsewhere-claude')).toHaveCount(0);

  // On the other account it is not in the list — and it is named, with the
  // account holding it, under a heading that says why it is not available here.
  await page.goto(`/settings?section=claude&tab=mcp&account=${id}`);
  await expect(page.getByTestId('mcp-servers-claude')).toBeVisible();
  await expect(page.getByTestId('mcp-server-memory')).toHaveCount(0);
  const elsewhere = page.getByTestId('mcp-elsewhere-claude');
  await expect(elsewhere).toContainText('On another account');
  await expect(elsewhere).toContainText('not available to a chat on this one');
  await expect(page.getByTestId('mcp-elsewhere-memory')).toContainText('System');
  await page.screenshot({ path: join(results, 'desktop-named-on-the-other-account.png') });

  // One click puts it here…
  await page.getByTestId('mcp-copy-here-memory').click();
  await expect(page.getByTestId('mcp-server-memory')).toBeVisible();
  // …and it stops being offered, without the rest of the panel going with it.
  await expect(page.getByTestId('mcp-copy-here-memory')).toHaveCount(0);
  await page.screenshot({ path: join(results, 'desktop-added-to-this-account.png') });

  // It landed in this account's own file, which is the one a chat on this
  // account is launched pointed at, and the System account still has its own.
  const mine = join(dataDir, 'profiles', 'claude', id, '.claude.json');
  await expect.poll(() => servers(mine).memory?.command, { timeout: 20_000 }).toBe('npx');
  expect(Object.keys(servers(systemFile))).toContain('memory');

  // Reopened, it is a server of this account like any other, not an offer.
  await page.reload();
  await expect(page.getByTestId('mcp-server-memory')).toBeVisible();
  await expect(page.getByTestId('mcp-elsewhere-memory')).toHaveCount(0);
});
