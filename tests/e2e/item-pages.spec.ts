import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Every plugin and MCP server row opens a page of its own (bw-moh1k).
 *
 * A row says a name and one line. Its page says the rest: what it is, who makes
 * it, what it adds, how it runs and its README — for something already
 * installed and for something in the catalogue alike.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/item-pages.spec.ts
 */

const results = 'tests/results/item-pages';
const marketplace = resolve('tests/fixtures/plugin-marketplace');
const TIDY = 'tidy-notes@beads-web-fixture';

test.describe.configure({ mode: 'serial' });

/** Waits for a popup to finish opening, so a screenshot shows it, not its fade. */
async function settled(page: Page, testId: string) {
  await page.getByTestId(testId).evaluate((el) => Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished)));
}

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('a catalogue plugin opens its page, is installed from it, and the installed row opens the same page', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=claude&tab=plugins&account=system');
  await expect(page.getByTestId('extensions-plugins')).toBeVisible();
  await page.getByTestId('marketplace-add').click();
  await page.getByTestId('marketplace-add-input').fill(marketplace);
  await page.getByTestId('marketplace-add-submit').click();
  await expect(page.getByTestId('extension-marketplaces-beads-web-fixture')).toBeVisible({ timeout: 60_000 });

  // In the catalogue, a row opens the plugin's page in place of the list.
  await page.getByTestId('plugin-browse').click();
  const search = page.getByTestId('plugin-catalogue-search');
  await search.fill('tidy notes');
  await page.getByTestId(`plugin-catalogue-open-${TIDY}`).click();
  const pluginPage = page.getByTestId('plugin-page');
  await expect(pluginPage).toBeVisible();
  await expect(page.getByTestId('plugin-page-title')).toHaveText('Tidy Notes');
  await expect(page.getByTestId('plugin-page-description')).toContainText('fixture plugin');
  await expect(page.getByTestId('plugin-page-readme')).toContainText('Sorts your notes by date', { timeout: 30_000 });
  await expect(page.getByTestId('plugin-page-includes-commands')).toContainText('/tidy-notes');
  await expect(page.getByTestId('plugin-page-includes-skills')).toContainText('sort-notes');
  await expect(page.getByTestId('plugin-page-includes-skills')).toContainText('Puts notes in date order');
  await expect(page.getByTestId('plugin-page-details')).toContainText('1.0.0');
  await settled(page, 'plugin-catalogue');
  await page.screenshot({ path: join(results, 'catalogue-page.png') });

  // Back returns to the list as it was left.
  await page.getByTestId('item-back').click();
  await expect(pluginPage).toHaveCount(0);
  await expect(search).toHaveValue('tidy notes');
  await expect(page.getByTestId(`plugin-entry-${TIDY}`)).toBeVisible();

  // Installed from its page.
  await page.getByTestId(`plugin-catalogue-open-${TIDY}`).click();
  await page.getByTestId(`plugin-page-install-${TIDY}`).click();
  await expect(page.getByTestId('plugin-catalogue')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId(`extension-plugins-${TIDY}`)).toBeVisible();

  // The installed row opens the same page in the same popup, over the list, named in the address.
  await page.getByTestId(`plugin-open-${TIDY}`).click();
  await expect(page.getByTestId('plugin-dialog').getByTestId('plugin-page')).toBeVisible();
  await expect(page.getByTestId(`extension-plugins-${TIDY}`)).toBeAttached();
  await expect(page.getByTestId('item-back')).toHaveCount(0);
  await expect(page).toHaveURL(/item=tidy-notes%40beads-web-fixture/);
  await expect(page.getByTestId('plugin-page-readme')).toContainText('Sorts your notes by date');
  const on = page.getByTestId(`plugin-page-enabled-${TIDY}`);
  await expect(on).toBeChecked();
  await settled(page, 'plugin-dialog');
  await page.screenshot({ path: join(results, 'installed-page.png') });

  // A reload lands on the same page; switching it off there is seen on the list.
  await page.reload();
  await expect(on).toBeChecked({ timeout: 30_000 });
  await on.click();
  await expect(on).not.toBeChecked({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('plugin-dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/item=/);
  await expect(page.getByTestId(`plugin-enabled-${TIDY}`)).not.toBeChecked();

  // Off, its servers are not linked; back on, a server it adds opens that server's page on the MCP tab.
  await page.getByTestId(`plugin-open-${TIDY}`).click();
  const servers = page.getByTestId('plugin-page-includes-mcp-servers');
  await expect(servers.getByRole('button', { name: 'tidy-index' })).toHaveCount(0);
  await on.click();
  await expect(on).toBeChecked({ timeout: 30_000 });
  await servers.getByRole('button', { name: 'tidy-index' }).click();
  await expect(page).toHaveURL(/tab=mcp/);
  await expect(page.getByTestId('mcp-dialog').getByTestId('mcp-page-title')).toHaveText('tidy-index', { timeout: 30_000 });
  await expect(page.getByTestId('mcp-page-details')).toContainText('tidy-notes plugin');
  await page.goto('/settings?section=claude&tab=plugins&account=system');

  // Uninstalled from its page, it leaves the list.
  await page.getByTestId(`plugin-open-${TIDY}`).click();
  await page.getByTestId(`plugin-page-remove-${TIDY}`).click();
  await expect(page.getByTestId(`extension-plugins-${TIDY}`)).toHaveCount(0, { timeout: 60_000 });
  await page.getByTestId('extension-remove-beads-web-fixture').click();
});

test('a catalogue server and an added server each open a page that says how they run', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=codex&tab=mcp&account=system');

  await page.getByTestId('mcp-browse').click();
  await page.getByTestId('catalogue-shelf-monitoring').click();
  await page.getByTestId('catalogue-open-inspektor-gadget').click();
  const mcpPage = page.getByTestId('mcp-page');
  await expect(mcpPage).toBeVisible();
  await expect(page.getByTestId('mcp-page-title')).toHaveText('Inspektor Gadget');
  await expect(mcpPage).toContainText('Needs Docker');
  await expect(page.getByTestId('mcp-page-details')).toContainText('Runs');
  await settled(page, 'mcp-catalogue');
  await page.screenshot({ path: join(results, 'catalogue-server.png') });
  await page.getByTestId('item-back').click();
  await expect(page.getByTestId('catalogue-entry-inspektor-gadget')).toBeVisible();
  await page.keyboard.press('Escape');

  // A server added by hand opens a page with its command and a Remove.
  await page.getByTestId('mcp-add').click();
  await page.getByTestId('mcp-add-id').fill('page-probe');
  await page.getByTestId('mcp-add-command').fill('node probe.js --quiet');
  await page.getByTestId('mcp-add-submit').click();
  await page.getByTestId('mcp-open-page-probe').click();
  await expect(page.getByTestId('mcp-dialog').getByTestId('mcp-page')).toBeVisible();
  await expect(page.getByTestId('mcp-server-page-probe')).toBeAttached();
  await expect(page).toHaveURL(/item=page-probe/);
  await expect(page.getByTestId('mcp-page-details')).toContainText('node probe.js --quiet');
  await expect(page.getByTestId('mcp-page-enabled-page-probe')).toBeChecked();
  await settled(page, 'mcp-dialog');
  await page.screenshot({ path: join(results, 'added-server.png') });
  await page.getByTestId('mcp-page-remove-page-probe').click();
  await expect(mcpPage).toHaveCount(0);
  await expect(page.getByTestId('mcp-server-page-probe')).toHaveCount(0);
});

test('Codex gets the same pages, and a server that comes with a Codex plugin is listed, linked and switched', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=codex&tab=plugins&account=system');
  await expect(page.getByTestId('extensions-plugins')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('marketplace-add').click();
  await page.getByTestId('marketplace-add-input').fill(marketplace);
  await page.getByTestId('marketplace-add-submit').click();
  await expect(page.getByTestId('extension-marketplaces-beads-web-fixture')).toBeVisible({ timeout: 60_000 });

  // The catalogue row opens the same page Claude's does, and installs from it.
  await page.getByTestId('plugin-browse').click();
  await page.getByTestId('plugin-catalogue-search').fill('tidy');
  await page.getByTestId(`plugin-catalogue-open-${TIDY}`).click();
  await expect(page.getByTestId('plugin-page-readme')).toContainText('Sorts your notes by date', { timeout: 30_000 });
  await expect(page.getByTestId('plugin-page-includes-mcp-servers')).toContainText('tidy-index');
  await settled(page, 'plugin-catalogue');
  await page.screenshot({ path: join(results, 'codex-catalogue-page.png') });
  await page.getByTestId(`plugin-page-install-${TIDY}`).click();
  await expect(page.getByTestId('plugin-catalogue')).toHaveCount(0, { timeout: 60_000 });

  // The installed plugin's server is on the MCP tab, under its own name.
  await page.getByTestId('provider-tabs-codex').getByTestId('provider-tab-mcp').click();
  const row = page.getByTestId('mcp-server-tidy-index');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('mcp-source-tidy-index')).toHaveText('tidy-notes plugin');
  await expect(page.getByTestId('mcp-remove-tidy-index')).toHaveCount(0);

  // Its page links to the plugin it comes with.
  await page.getByTestId('mcp-open-tidy-index').click();
  await expect(page.getByTestId('mcp-page-details')).toContainText('index.js');
  await settled(page, 'mcp-dialog');
  await page.screenshot({ path: join(results, 'codex-plugin-server.png') });
  await page.getByTestId('mcp-page-plugin').click();
  await expect(page).toHaveURL(/tab=plugins/);
  await expect(page.getByTestId('plugin-page-title')).toHaveText('Tidy Notes', { timeout: 30_000 });

  // Switched off on its page, it stays off when the list is read again.
  await page.goto('/settings?section=codex&tab=mcp&account=system&item=tidy-index');
  const on = page.getByTestId('mcp-page-enabled-tidy-index');
  await expect(on).toBeChecked({ timeout: 30_000 });
  await on.click();
  await expect(on).not.toBeChecked({ timeout: 30_000 });
  await page.reload();
  await expect(on).not.toBeChecked({ timeout: 30_000 });

  await page.goto('/settings?section=codex&tab=plugins&account=system');
  await page.getByTestId(`extension-remove-${TIDY}`).click();
  await expect(page.getByTestId(`extension-plugins-${TIDY}`)).toHaveCount(0, { timeout: 60_000 });
  await page.getByTestId('extension-remove-beads-web-fixture').click();
});
