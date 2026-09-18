import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Copy to… copies the sections that were ticked, and only those (bw-6ecp.5).
 *
 * It used to copy whichever settings page happened to be open, with no list of
 * what would move and no way to move the two things most worth moving — the
 * account's MCP servers and its plugins. Now the sheet lists every section with
 * a checkbox, and an unticked section is not touched in the target.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/copy-to-sections.spec.ts
 */

const results = 'tests/results/copy-to-sections';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

const command = async (request: APIRequestContext, data: Record<string, unknown>) => {
  const r = await request.post('/api/workbench/command', { data });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json() as Promise<Record<string, unknown>>;
};

const account = (brand: string, id: string) => join(process.env.ATELIER_DATA_DIR!, 'profiles', brand, id);
const text = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

test('a Claude account gives another its defaults and its servers, and leaves the rest alone', async ({ page, request }) => {
  const { profile } = (await command(request, { type: 'profile.create', brand: 'claude', name: 'Target' })) as { profile: { id: string } };
  const id = profile.id;

  // Something of the target's own, in a section that will NOT be ticked.
  await command(request, {
    type: 'provider-settings.write',
    brand: 'claude',
    scope: 'account',
    profileId: id,
    layer: 'user',
    patch: { 'permissions.defaultMode': 'plan' },
  });

  // Something to copy: a default, and a server.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=claude&account=system');
  await page.locator('#setting-claude-effortLevel').click();
  await page.getByRole('option', { name: /^Medium/ }).click();
  await expect(page.locator('#setting-claude-effortLevel')).toContainText('Medium');

  await page.goto('/settings?section=claude&tab=mcp&account=system');
  await page.getByTestId('mcp-add').click();
  await page.getByTestId('mcp-add-id').fill('copyProbe');
  await page.getByTestId('mcp-add-command').fill('npx -y @modelcontextprotocol/server-memory');
  await page.getByTestId('mcp-add-submit').click();
  await expect(page.getByTestId('mcp-server-copyProbe')).toBeVisible();

  // Every section is on the sheet, each with a box of its own.
  await page.goto('/settings?section=claude&account=system');
  await page.getByTestId('copy-to-accounts-claude').click();
  const sheet = page.getByTestId('copy-to-accounts-dialog');
  await expect(sheet).toBeVisible();
  for (const section of ['defaults', 'permissions', 'mcp', 'plugins']) {
    await expect(page.getByTestId(`copy-section-${section}`)).toBeVisible();
  }
  // The page being looked at starts ticked; the others do not.
  await expect(page.getByTestId('copy-section-defaults')).toBeChecked();
  await expect(page.getByTestId('copy-section-permissions')).not.toBeChecked();

  await page.getByTestId('copy-section-mcp').click();
  await page.getByTestId(`copy-to-${id}`).click();
  await page.screenshot({ path: join(results, 'claude-sections.png') });
  await page.getByTestId('copy-to-accounts-confirm').click();
  await expect(sheet).toHaveCount(0);

  const settings = () => {
    try {
      return JSON.parse(readFileSync(join(account('claude', id), 'settings.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  // The ticked page arrived…
  await expect.poll(() => settings().effortLevel).toBe('medium');
  // …the unticked one was not touched, neither copied nor cleared…
  expect((settings().permissions as Record<string, unknown>).defaultMode).toBe('plan');
  // …and the server is in the file the CLI reads for that account.
  await expect
    .poll(() => Object.keys((JSON.parse(text(join(account('claude', id), '.claude.json')) || '{}').mcpServers ?? {}) as object))
    .toContain('copyProbe');

  // The target now lists it as its own.
  await page.goto(`/settings?section=claude&tab=mcp&account=${id}`);
  await expect(page.getByTestId('mcp-server-copyProbe')).toBeVisible();
  await page.screenshot({ path: join(results, 'claude-target-servers.png') });
});

test('a Codex account is offered the same sheet, without the plugins it does not have', async ({ page, request }) => {
  const { profile } = (await command(request, { type: 'profile.create', brand: 'codex', name: 'Target' })) as { profile: { id: string } };
  const id = profile.id;

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=codex&tab=mcp&account=system');
  await page.getByTestId('mcp-add').click();
  await page.getByTestId('mcp-add-id').fill('codexProbe');
  await page.getByTestId('mcp-add-command').fill('npx -y @modelcontextprotocol/server-memory');
  await page.getByTestId('mcp-add-submit').click();
  await expect(page.getByTestId('mcp-server-codexProbe')).toBeVisible();

  await page.getByTestId('copy-to-accounts-codex').click();
  await expect(page.getByTestId('copy-section-mcp')).toBeVisible();
  // Codex has no plugin system, so it is not offered one.
  await expect(page.getByTestId('copy-section-plugins')).toHaveCount(0);
  // The sheet was opened from the MCP tab, so that is the section already ticked.
  await expect(page.getByTestId('copy-section-mcp')).toBeChecked();
  await expect(page.getByTestId('copy-section-defaults')).not.toBeChecked();

  await page.getByTestId(`copy-to-${id}`).click();
  await page.screenshot({ path: join(results, 'codex-sections.png') });
  await page.getByTestId('copy-to-accounts-confirm').click();
  await expect(page.getByTestId('copy-to-accounts-dialog')).toHaveCount(0);

  await expect.poll(() => text(join(account('codex', id), 'config.toml'))).toContain('codexProbe');
});
