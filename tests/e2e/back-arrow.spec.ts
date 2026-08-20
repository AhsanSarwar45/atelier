import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The arrow in the project bar: back where he came from, not back to the front
 * door.
 *
 * Opening a report from a chat pushes an address, so the way out of that report
 * is the way in — the chat, at the message that named it. The arrow used to be
 * a plain link to the project list, which threw the whole visit away; and since
 * the Reports tab has no back-to-list of its own, that was the only way out of
 * an open report (bw-zhgh).
 *
 * The list is still where it goes when there is nothing of ours behind it: a
 * pasted address, a fresh tab. Stepping back there would leave the app.
 *
 * Needs an instance with at least one project.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3008 \
 *      npx playwright test tests/e2e/back-arrow.spec.ts
 */

async function projectId(request: APIRequestContext): Promise<string> {
  if (process.env.BEADS_E2E_PROJECT) return process.env.BEADS_E2E_PROJECT;
  const api = process.env.BEADS_E2E_BACKEND ?? '';
  const projects = (await (await request.get(`${api}/api/projects`)).json()) as { id: string }[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  return projects[0].id;
}

test.describe('the project bar arrow', () => {
  test('gives back a move made inside the app', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto(`/project?id=${id}&tab=board`);
    await expect(page.getByTestId('back-arrow')).toBeVisible({ timeout: 30_000 });

    // The tabs push, the same as a report chip does.
    await page.getByRole('tab', { name: /report/i }).click();
    await expect(page).toHaveURL(/tab=reports/);

    await page.getByTestId('back-arrow').click();
    await expect(page, 'the arrow went to the list instead of back').toHaveURL(/tab=board/);
  });

  test('gives back a whole page the reader loaded', async ({ page, request }) => {
    const id = await projectId(request);
    await page.goto('/');
    await page.goto(`/project?id=${id}&tab=board`);
    await page.goto(`/project?id=${id}&tab=reports`);
    await expect(page.getByTestId('back-arrow')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('back-arrow').click();
    await expect(page).toHaveURL(/tab=board/);
  });

  test('falls back to the list when nothing of ours is behind it', async ({ page, request }) => {
    const id = await projectId(request);
    // A fresh context, so this address is the first thing the tab ever had.
    await page.goto(`/project?id=${id}&tab=reports`);
    await expect(page.getByTestId('back-arrow')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('back-arrow').click();
    await expect(page, 'a cold-opened address stepped out of the app').toHaveURL(/\/$/);
  });
});
