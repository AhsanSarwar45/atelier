import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const FIXTURE = join(__dirname, '..', '.workbench-run-new-chat-hover');

/**
 * Why an agent cannot be started belongs to the button that is grey, and only
 * while the reader is asking about it. A standing block of red-flag text under
 * the choices made the chooser read as an error report before anybody had
 * done anything (bw-uyk2.1).
 */
test('the new-chat chooser explains a grey agent on hover, not in standing text', async ({ page, request }) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'new-chat-hover', path: FIXTURE },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  try {
    const listed = await request.post('/api/workbench/command', {
      data: { type: 'providers.list' },
    });
    expect(listed.ok(), await listed.text()).toBe(true);
    const providers = ((await listed.json()) as {
      providers: Array<{ brand: string; available: boolean; availabilityReason?: string }>;
    }).providers;
    const grey = providers.find((entry) => !entry.available);
    expect(grey, 'every provider is available, so nothing here can be proved').toBeDefined();

    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    const dialog = page.getByTestId('new-chat-provider-dialog');
    await expect(dialog).toBeVisible();
    // The dialog fades and scales in over the screen behind it; a shot taken
    // while that is running has both drawn on top of each other.
    await page.waitForTimeout(600);
    const box = (await dialog.boundingBox())!;
    const shot = {
      x: Math.max(0, box.x - 40),
      y: Math.max(0, box.y - 40),
      width: box.width + 80,
      height: box.height + 160,
    };
    const name = process.env.BW_UYK2_SHOT ?? 'shot';
    await page.screenshot({ path: `tests/results/bw-uyk2-${name}-resting.png`, clip: shot, animations: 'disabled' });

    // The wrapper, not the button: a disabled control takes no pointer events,
    // so the one tooltip component puts the label on the span it wraps it in.
    await page.getByTestId(`new-chat-provider-${grey!.brand}`).locator('xpath=..').hover();
    await expect(page.getByRole('tooltip')).toContainText(grey!.availabilityReason ?? 'Install');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `tests/results/bw-uyk2-${name}-hover.png`, clip: shot, animations: 'disabled' });

    await expect(page.getByTestId('new-chat-provider-dialog').getByTestId('provider-unavailable-reasons')).toHaveCount(0);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
