import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Adding a server, a plugin or a marketplace opens the same sheet the rest of
 * the app adds things with (bw-6ecp.3).
 *
 * All three were forms that appeared in the middle of the list they belonged
 * to: the server form pushed the servers down the page, and the two plugin
 * ones were a bare input beside the Add button, with an incantation for a
 * placeholder and nothing saying what it wanted. On a phone that is a form
 * with no room and no title. They are now the bottom sheet Add Project wears,
 * titled, with a line saying what to type.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/add-sheets.spec.ts
 */

const results = 'tests/results/add-sheets';
const phone = { width: 390, height: 844 };

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

/**
 * A sheet on a phone: the whole width, flush with the bottom edge.
 *
 * Polled rather than measured once — it slides up from the bottom, and a box
 * taken mid-animation is wherever the slide had got to.
 */
async function isASheet(page: Page, testid: string) {
  const sheet = page.getByTestId(testid);
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox();
      return box ? Math.round(box.y + box.height) : -1;
    })
    .toBe(phone.height);
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(phone.width);
}

test('the three add forms are one sheet, reachable and dismissible on a phone', async ({ page }) => {
  await page.setViewportSize(phone);

  await page.goto('/settings?section=claude&tab=mcp&account=system');
  await page.getByTestId('mcp-add').click();
  await expect(page.getByTestId('mcp-add-form')).toBeVisible();
  await expect(page.getByTestId('mcp-add-form')).toContainText('Add an MCP server');
  await isASheet(page, 'mcp-add-form');
  await page.screenshot({ path: join(results, 'phone-add-server.png') });
  // The way out every sheet in the app has.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mcp-add-form')).toHaveCount(0);

  await page.goto('/settings?section=claude&tab=plugins&account=system');
  await page.getByTestId('marketplace-add').click();
  await expect(page.getByTestId('marketplace-add-form')).toContainText('Add a marketplace');
  await expect(page.getByTestId('marketplace-add-form')).toContainText('repository of plugins');
  await isASheet(page, 'marketplace-add-form');
  await page.screenshot({ path: join(results, 'phone-add-marketplace.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('marketplace-add-form')).toHaveCount(0);

  await page.getByTestId('plugin-install').click();
  await expect(page.getByTestId('plugin-install-form')).toContainText('Install a plugin');
  await isASheet(page, 'plugin-install-form');
  await page.screenshot({ path: join(results, 'phone-install-plugin.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('plugin-install-form')).toHaveCount(0);
});

test('a server is still added from the sheet, and the list is not moved to make room', async ({ page }) => {
  await page.setViewportSize(phone);
  await page.goto('/settings?section=claude&tab=mcp&account=system');
  const list = page.getByTestId('mcp-servers-claude');
  await expect(list).toBeVisible();
  const before = (await list.boundingBox())!.y;

  await page.getByTestId('mcp-add').click();
  // The sheet floats over the list rather than pushing it down the page.
  expect((await list.boundingBox())!.y).toBe(before);
  await page.getByTestId('mcp-add-id').fill('sheetProbe');
  await page.getByTestId('mcp-add-command').fill('npx -y @modelcontextprotocol/server-memory');
  await page.getByTestId('mcp-add-submit').click();
  await expect(page.getByTestId('mcp-add-form')).toHaveCount(0);
  await expect(page.getByTestId('mcp-server-sheetProbe')).toBeVisible();
  await page.screenshot({ path: join(results, 'phone-added.png') });
});
