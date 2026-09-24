import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator } from '@playwright/test';

/**
 * The project bar keeps every control in its own place on a phone (bw-weih.10).
 *
 * The owner's phone showed a project with a long name and two notifications:
 * the project menu's three dots sat a long way from the name's arrow and ran
 * into the bell. The bell's holder took the free space and shrank to nothing
 * when there was none, and its bell then spilled out to the left over the
 * dots. The name is what gives way now, and each control keeps its own box.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-project-bar-keeps-its-order-on-a-phone.spec.ts
 */

const SHOTS = 'tests/results/the-project-bar-on-a-phone';

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found, 'the control is drawn').not.toBeNull();
  return found!;
}

for (const width of [360, 390, 432]) {
  test(`the name, its menu and the bell do not overlap at ${width}px`, async ({ page, request }) => {
    const root = process.env.WORKBENCH_E2E_RUN!;
    const path = join(root, `bar-project-${width}`);
    mkdirSync(path, { recursive: true });
    const made = await request.post('/api/projects', {
      data: { name: 'FirstPrinciples', path },
    });
    expect(made.ok(), await made.text()).toBeTruthy();
    const project = (await made.json()) as { id: string };

    const row = (id: string) => ({
      id,
      name: `Chat ${id}`,
      projectId: project.id,
      projectName: 'FirstPrinciples',
      state: 'waiting',
      says: 'Waiting on you',
      href: `/project?id=${project.id}&tab=chat`,
      needsAction: true,
      at: new Date(0).toISOString(),
    });
    await page.route(/\/api\/workbench\/notifications(?:\?.*)?$/, (route) =>
      route.fulfill({ json: [row('one'), row('two')] }),
    );

    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const name = page.getByTestId('project-switch');
    const menu = page.getByTestId('project-menu');
    const bell = page.getByTestId('tray-badge');
    const hamburger = page.getByTestId('shell-menu');
    await expect(bell).toBeVisible();
    await page.waitForTimeout(500);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${width}.png`), clip: { x: 0, y: 0, width, height: 60 } });

    const [n, m, b, h] = [await box(name), await box(menu), await box(bell), await box(hamburger)];
    // In order along the bar, and none drawn over its neighbour.
    expect(m.x, 'the menu starts after the name ends').toBeGreaterThanOrEqual(n.x + n.width);
    expect(b.x, 'the bell starts after the menu ends').toBeGreaterThanOrEqual(m.x + m.width);
    expect(h.x, 'the hamburger starts after the bell ends').toBeGreaterThanOrEqual(b.x + b.width);
    // The menu belongs to the name: it sits beside it, not across the bar.
    expect(m.x - (n.x + n.width), 'the menu sits close to the name').toBeLessThanOrEqual(8);
    expect(h.x + h.width, 'the bar fits the screen').toBeLessThanOrEqual(width);
  });
}
