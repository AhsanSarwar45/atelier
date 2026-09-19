import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * An MCP server and a plugin are known by their own icon wherever they are
 * listed, and a row says what the thing is for (bw-6ecp.16).
 *
 * A row used to open with its raw launch command — `npx -y
 * @modelcontextprotocol/server-memory` — which is all a settings file holds and
 * tells a reader nothing about what the server is. Now a server already on an
 * account is matched back to the catalogue by what starts it, and wears that
 * record's name, line and icon; the command is a detail the reader can open.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/mcp-icons.spec.ts
 */

const results = 'tests/results/mcp-icons';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('a server on the account wears its catalogue record, with the command demoted', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=claude&tab=mcp&account=system');

  // Added from the catalogue, so the catalogue certainly knows it…
  await page.getByTestId('mcp-browse').click();
  await page.getByTestId('mcp-catalogue-search').fill('duckduckgo');
  const row = page.getByTestId('catalogue-entry-duckduckgo');
  await expect(row).toBeVisible();
  await page.getByTestId('catalogue-add-duckduckgo').click();

  // …and the row it lands on says what it is, not how it starts.
  const listed = page.getByTestId('mcp-server-duckduckgo');
  await expect(listed).toBeVisible();
  await expect(listed).toContainText(/duckduckgo/i);
  await expect(listed).not.toContainText('docker run');
  await expect(listed.locator('img, svg').first()).toBeVisible();

  // The command is still one click away, and exact.
  await page.getByTestId('mcp-launch-toggle-duckduckgo').click();
  await expect(page.getByTestId('mcp-launch-duckduckgo')).toContainText('docker run -i --rm mcp/duckduckgo');
  await page.screenshot({ path: join(results, 'server-row.png') });
});

test('a server the catalogue has never heard of still says how it starts', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=codex&tab=mcp&account=system');

  await page.getByTestId('mcp-add').click();
  await page.getByTestId('mcp-add-id').fill('homeGrown');
  await page.getByTestId('mcp-add-command').fill('python3 ./my-own-server.py');
  await page.getByTestId('mcp-add-submit').click();

  const listed = page.getByTestId('mcp-server-homeGrown');
  await expect(listed).toBeVisible();
  // Nothing was invented about it: the command is the subtitle, as before.
  await expect(listed).toContainText('python3 ./my-own-server.py');
  // And it still has a mark of its kind rather than an empty hole.
  await expect(listed.locator('svg').first()).toBeVisible();
  await page.screenshot({ path: join(results, 'unknown-row.png') });
});

test('a plugin and a marketplace each carry a mark of their kind', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=claude&tab=plugins&account=system');
  await expect(page.getByTestId('extensions-plugins')).toBeVisible();

  await page.getByTestId('marketplace-add').click();
  await page.getByTestId('marketplace-add-input').fill(process.cwd() + '/tests/fixtures/plugin-marketplace');
  await page.getByTestId('marketplace-add-submit').click();
  const market = page.getByTestId('extension-marketplaces-beads-web-fixture');
  await expect(market).toBeVisible({ timeout: 60_000 });
  await expect(market.locator('svg').first()).toBeVisible();

  await page.getByTestId('plugin-browse').click();
  await page.getByTestId('plugin-catalogue-search').fill('tidy');
  await page.getByTestId('plugin-catalogue-install-tidy-notes@beads-web-fixture').click();
  const plugin = page.getByTestId('extension-plugins-tidy-notes@beads-web-fixture');
  await expect(plugin).toBeVisible({ timeout: 60_000 });
  await expect(plugin.locator('svg').first()).toBeVisible();
  await page.screenshot({ path: join(results, 'plugin-rows.png') });
});
