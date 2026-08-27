import { expect, test } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = join(__dirname, '..', '.workbench-run-desktop-panels');
const SHOT = join(__dirname, '..', 'results', 'desktop-panels-after.png');

test('both desktop dividers resize their panels while the transcript viewport fills the center', async ({ page, request }) => {
  test.setTimeout(120_000);
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  const created = await request.post('/api/projects', {
    data: { name: 'desktop-panels', path: FIXTURE, isTest: true },
  });
  expect(created.status(), await created.text()).toBe(201);
  const project = (await created.json()) as { id: string };

  try {
    const started = await request.post('/api/workbench/command', {
      data: { type: 'session.start', projectId: project.id, projectPath: FIXTURE, brand: 'claude' },
    });
    expect(started.status(), await started.text()).toBe(200);
    const session = (await started.json()) as { id: string };

    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.goto(`/project?id=${project.id}&chat=${session.id}`);
    await page.getByTestId('tab-chat').click();
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 30_000 });

    const left = page.getByTestId('chat-rail');
    const right = page.getByTestId('chat-right-rail');
    const transcript = page.getByTestId('transcript');
    const rows = page.getByTestId('transcript-rows');
    const width = (locator: typeof left) => locator.evaluate((el) => el.getBoundingClientRect().width);

    const leftBefore = await width(left);
    const centerBefore = await width(transcript);
    const leftHandle = await page.getByTestId('left-panel-resizer').boundingBox();
    expect(leftHandle).not.toBeNull();
    await page.mouse.move(leftHandle!.x + leftHandle!.width / 2, leftHandle!.y + 100);
    await page.mouse.down();
    await page.mouse.move(leftHandle!.x + leftHandle!.width / 2 + 96, leftHandle!.y + 100);
    await page.mouse.up();
    expect(await width(left)).toBeGreaterThan(leftBefore + 80);
    expect(await width(transcript)).toBeLessThan(centerBefore - 80);

    const rightBefore = await width(right);
    const rightHandle = await page.getByTestId('right-panel-resizer').boundingBox();
    expect(rightHandle).not.toBeNull();
    await page.mouse.move(rightHandle!.x + rightHandle!.width / 2, rightHandle!.y + 100);
    await page.mouse.down();
    await page.mouse.move(rightHandle!.x + rightHandle!.width / 2 - 80, rightHandle!.y + 100);
    await page.mouse.up();
    expect(await width(right)).toBeGreaterThan(rightBefore + 64);

    const viewportBox = await transcript.boundingBox();
    const contentBox = await rows.boundingBox();
    expect(viewportBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    expect(viewportBox!.width).toBeGreaterThan(contentBox!.width + 100);
    expect(Math.abs(contentBox!.x + contentBox!.width / 2 - (viewportBox!.x + viewportBox!.width / 2))).toBeLessThan(2);
    await page.screenshot({ path: SHOT, fullPage: false });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
