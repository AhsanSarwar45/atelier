import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * The Largest chats list leaves room for each chat's name.
 *
 * The manager's report, with a picture of names cut to one or two letters:
 * "the name column needs to be much bigger its not visible at all and the
 * 'open card' badge decreases that space even more" (bw-4j9pr).
 *
 * The other columns took whatever width they wanted and the name got what was
 * left. Now they have fixed widths, and the badges sit on the second line
 * beside the project, so the name line is the name alone.
 *
 *   scripts/workbench-e2e.sh tests/e2e/largest-chats-show-their-names.spec.ts
 */
const SHOTS = join(process.cwd(), 'tests', 'results');

const LONG = 'Copyleaks check fails on long documents after the upload limit change';

test('a long chat name gets most of the row, badges and all', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  const chats = [
    { id: 'c1', title: LONG, projectId: 'p1', lastAt: '2026-10-05T10:00:00Z', bytes: 1.3e9, media: 0, active: false, kept: true },
    { id: 'c2', title: 'Preview task runner output', projectId: 'p1', lastAt: '2026-10-16T10:00:00Z', bytes: 1.0e9, media: 0, active: true, kept: true },
    { id: 'c3', title: 'Ticket rejected by QA', projectId: 'p1', lastAt: '2026-10-07T10:00:00Z', bytes: 5.0e7, media: 0, active: false, kept: false },
  ];
  await page.route('**/api/storage/chats?*', (route) => route.fulfill({ json: { chats, ready: true } }));
  await page.goto('/settings?section=storage');

  const rows = page.getByTestId('storage-largest-chat');
  await expect(rows).toHaveCount(3);
  const first = rows.first();
  await expect(first.getByText('Open card')).toBeVisible();

  const table = (await page.getByTestId('storage-largest').locator('table').boundingBox())!;
  const nameCell = (await first.locator('td').first().boundingBox())!;
  expect(nameCell.width).toBeGreaterThan(table.width / 2);

  // The name line holds only the name, so the badge takes nothing from it.
  const name = (await first.getByRole('link', { name: LONG, exact: true }).boundingBox())!;
  const badge = (await first.getByText('Open card').boundingBox())!;
  expect(badge.y).toBeGreaterThanOrEqual(name.y + name.height - 1);
  expect(name.width).toBeGreaterThan(250);

  await page.getByTestId('storage-largest').screenshot({ path: join(SHOTS, 'largest-chats-names.png') });
});
