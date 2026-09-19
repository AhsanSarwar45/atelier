import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * An MCP server is found in the catalogue and added in one click (bw-6ecp.6).
 *
 * Adding one used to mean knowing the package name and the flags it wants.
 * Now there is a catalogue: shelves to browse, a box to search, an icon and a
 * line about each server, and an Add button that writes the configuration.
 *
 * Browsing is asserted against the bundled set, which is compiled into the
 * binary and is the same on every machine. Searching goes to the official
 * registry, whose answer this machine cannot promise, so what is asserted
 * about a search is only what holds either way: rows come back, and they are
 * about what was typed.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/mcp-catalogue.spec.ts
 */

const results = 'tests/results/mcp-catalogue';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

test('a shelf narrows the catalogue and a server on it is added in one click', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=claude&tab=mcp&account=system');

  await page.getByTestId('mcp-browse').click();
  const sheet = page.getByTestId('mcp-catalogue');
  await expect(sheet).toBeVisible();

  // The bundled set arrives categorised, with more than one shelf on it.
  const list = page.getByTestId('mcp-catalogue-list');
  await expect(list).toBeVisible();
  await expect(page.getByTestId('mcp-catalogue-shelves').getByRole('button')).not.toHaveCount(1);
  await page.screenshot({ path: join(results, 'shelves.png') });

  // A shelf narrows the list to its own servers…
  const all = await list.locator('li').count();
  await page.getByTestId('catalogue-shelf-monitoring').click();
  await expect.poll(async () => list.locator('li').count()).toBeLessThan(all);
  // …and what is on it says what it is, not just what starts it.
  const row = page.getByTestId('catalogue-entry-inspektor-gadget');
  await expect(row).toContainText('Inspektor Gadget');
  await expect(row).toContainText('Needs Docker');
  await page.screenshot({ path: join(results, 'shelf.png') });

  // One click, and it is configured and listed as the account's own.
  await page.getByTestId('catalogue-add-inspektor-gadget').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('mcp-server-inspektor-gadget')).toBeVisible();
  await page.screenshot({ path: join(results, 'added.png') });
});

test('a server that cannot start without a key asks for it before it is added', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=codex&tab=mcp&account=system');

  await page.getByTestId('mcp-browse').click();
  await page.getByTestId('catalogue-shelf-search').click();
  const add = page.getByTestId('catalogue-add-brave');
  await expect(add).toBeVisible();

  // The first click does not add it: it asks for what it needs, and will not
  // go on until it has it.
  await add.click();
  const needs = page.getByTestId('catalogue-needs-brave');
  await expect(needs).toBeVisible();
  await expect(page.getByTestId('catalogue-confirm-brave')).toBeDisabled();
  await page.screenshot({ path: join(results, 'needs.png') });

  await page.getByTestId('catalogue-need-brave-BRAVE_API_KEY').fill('a-test-key');
  await page.getByTestId('catalogue-confirm-brave').click();
  await expect(page.getByTestId('mcp-catalogue')).toHaveCount(0);
  await expect(page.getByTestId('mcp-server-brave')).toBeVisible();
});

test('typing finds servers by name, and the shelves step aside while it does', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=claude&tab=mcp&account=system');

  await page.getByTestId('mcp-browse').click();
  // A shelf ticked before the search must not narrow what the search finds.
  await page.getByTestId('catalogue-shelf-monitoring').click();
  await page.getByTestId('mcp-catalogue-search').fill('duckduckgo');

  await expect(page.getByTestId('mcp-catalogue-shelves')).toHaveCount(0);
  const list = page.getByTestId('mcp-catalogue-list');
  await expect(list.locator('li').first()).toContainText(/duckduckgo/i);
  await page.screenshot({ path: join(results, 'searched.png') });

  // Nothing is published under this, from either source.
  await page.getByTestId('mcp-catalogue-search').fill('zzzqqqnotathing');
  await expect(page.getByTestId('mcp-catalogue-none')).toBeVisible();
});

test('on a phone the catalogue is a sheet on the bottom edge', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings?section=claude&tab=mcp&account=system');
  await page.getByTestId('mcp-browse').click();

  const sheet = page.getByTestId('mcp-catalogue');
  await expect(sheet).toBeVisible();
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox();
      return box ? Math.round(box.y + box.height) : -1;
    })
    .toBe(844);
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(390);
  await expect(page.getByTestId('mcp-catalogue-list')).toBeVisible();
  await page.screenshot({ path: join(results, 'phone.png') });
});
