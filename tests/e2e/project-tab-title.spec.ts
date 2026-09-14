import { expect, test } from '@playwright/test';

test('a known project keeps its name in the browser title through a reload', async ({ page, request }) => {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  const made = await request.post('/api/projects', {
    data: { name: 'Aspen', path: process.cwd(), isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  try {
    await page.goto('/');
    await page.getByRole('link', { name: 'View Aspen project' }).click();
    await expect(page).toHaveURL(new RegExp(`/project\\?id=${project.id}`));
    await expect(page).toHaveTitle('Aspen | Atelier');

    // Hold the project record back on the second load. The head script has to
    // restore the title on its own; React cannot borrow the answer from this
    // request yet.
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle('Aspen | Atelier');
    await expect(page.getByRole('heading', { name: 'Aspen' })).toBeVisible();
    await page.screenshot({ path: 'tests/results/bw-qgza-project-title.png' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});
