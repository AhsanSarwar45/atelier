import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * A settings sheet directs the reader with labels, not paragraphs (bw-ocyd.1),
 * and on a phone its pages are a picker rather than a cramped row of tabs
 * (bw-ocyd.2).
 *
 * The sheets used to open with a sentence or two explaining themselves, which
 * is a reading assignment in front of the control the reader came for. What is
 * asserted here is the shape of the heading: a short title, and either no
 * visible description at all or a phrase. The long form is kept for screen
 * readers, where a sentence costs nothing.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/settings-say-it-in-labels.spec.ts
 */

const results = 'tests/results/settings-labels';
const PHONE = { width: 390, height: 844 };

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(results, { recursive: true });
});

/** The title and the described-by element of an open sheet, as drawn. */
async function heading(page: import('@playwright/test').Page, testid: string) {
  return page.getByTestId(testid).evaluate((el) => {
    const id = el.getAttribute('aria-describedby');
    const described = id ? document.getElementById(id) : null;
    return {
      title: (el.querySelector('h2')?.textContent ?? '').trim(),
      description: (described?.textContent ?? '').trim(),
      spokenOnly: described ? described.className.includes('sr-only') : true,
    };
  });
}

/** A sheet says what it is in a label's worth of words. */
async function saysItShort(page: import('@playwright/test').Page, testid: string, shot: string) {
  const head = await heading(page, testid);
  expect(head.title.length, `${testid} title: ${head.title}`).toBeLessThanOrEqual(24);
  if (!head.spokenOnly) {
    expect(head.description.length, `${testid} description: ${head.description}`).toBeLessThanOrEqual(48);
  }
  await page.screenshot({ path: join(results, shot) });
}

test('every settings sheet opens with a label, not a paragraph', async ({ page, request }) => {
  // Copy to… is only offered when there is somewhere to copy to.
  const made = await request.post('/api/workbench/command', { data: { type: 'profile.create', brand: 'claude', name: 'Labels' } });
  expect(made.ok(), await made.text()).toBeTruthy();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?section=claude&tab=mcp&account=system');

  await page.getByTestId('mcp-add').click();
  await expect(page.getByTestId('mcp-add-form')).toBeVisible();
  await saysItShort(page, 'mcp-add-form', 'mcp-add.png');
  await page.keyboard.press('Escape');

  await page.getByTestId('mcp-browse').click();
  await expect(page.getByTestId('mcp-catalogue-list')).toBeVisible();
  await saysItShort(page, 'mcp-catalogue', 'mcp-catalogue.png');
  await page.keyboard.press('Escape');

  await page.getByTestId('copy-to-accounts-claude').click();
  const copy = page.getByTestId('copy-to-accounts-dialog');
  await expect(copy).toBeVisible();
  await expect(copy.getByTestId('copy-to-sections')).toContainText('Replaces');
  await saysItShort(page, 'copy-to-accounts-dialog', 'copy-to.png');
  await page.keyboard.press('Escape');

  await page.goto('/settings?section=claude&tab=plugins&account=system');
  await expect(page.getByTestId('extensions-plugins')).toBeVisible();
  await page.getByTestId('plugin-install').click();
  await saysItShort(page, 'plugin-install-form', 'plugin-install.png');
  await page.keyboard.press('Escape');

  await page.getByTestId('marketplace-add').click();
  await saysItShort(page, 'marketplace-add-form', 'marketplace-add.png');
  await page.keyboard.press('Escape');

  await page.getByTestId('plugin-browse').click();
  await saysItShort(page, 'plugin-catalogue', 'plugin-catalogue.png');
});

test('on a phone the pages are one picker, not a row of tabs', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/settings?section=claude&tab=defaults&account=system');

  // The row of tabs is a wide screen's; a phone gets the picker instead.
  await expect(page.getByTestId('provider-tabs-claude')).toBeHidden();
  const picker = page.getByTestId('provider-page-claude');
  await expect(picker).toBeVisible();
  await expect(picker).toContainText('Defaults');
  await page.screenshot({ path: join(results, 'phone-pages.png') });

  // Choosing from it opens the page, the same as pressing a tab would.
  await picker.click();
  await page.getByTestId('provider-page-mcp').click();
  await expect(page.getByTestId('mcp-add')).toBeVisible();
  await expect(picker).toContainText('MCP servers');
  await page.screenshot({ path: join(results, 'phone-mcp.png') });
});
