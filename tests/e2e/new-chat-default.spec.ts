import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const FIXTURE = join(__dirname, '..', '.workbench-run-new-chat-default');

/**
 * The star beside a provider, and what a default now means (bw-5ihw.6).
 *
 * It used to be a checkbox in the footer that could only ever speak for
 * whichever provider happened to be selected, and setting it made the next
 * New Chat skip the dialog and start a chat on the spot. The dialog asks
 * three things now — which agent, which account, and where to work — so
 * skipping it would answer two of them silently. A default is what the dialog
 * opens holding.
 */
test('a starred provider is what the dialog opens on, and never a way past it', async ({
  page,
  request,
}) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await request.post('/api/projects', {
    data: { name: 'new-chat-default', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  try {
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();

    const dialog = page.getByTestId('new-chat-provider-dialog');
    await expect(dialog).toBeVisible();
    // The checkbox that spoke for whatever was selected is gone.
    await expect(page.getByTestId('new-chat-default')).toHaveCount(0);

    const star = page.getByTestId('new-chat-provider-default-codex');
    await expect(star).toHaveAttribute('data-default', 'false');
    await star.click();
    await expect(star).toHaveAttribute('data-default', 'true');
    // Kept where the next tab will find it, not in this browser.
    await expect
      .poll(async () => (await (await request.get('/api/settings/new-chat')).json()).provider)
      .toBe('codex');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // The whole of the change: a starred provider opens the dialog holding
    // that provider, rather than starting a chat without asking.
    await page.getByTestId('new-chat-tool').click();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('new-chat-provider-codex')).toHaveClass(/bg-primary/);

    // One account and no section: an Account row that only ever says "System"
    // is a question with one answer. The local brand never has one at all,
    // which is guarded where it is written (selector-defaults.test.ts).
    await expect(page.getByTestId('new-chat-profiles')).toHaveCount(0);

    await dialog.screenshot({ path: 'tests/results/bw-5ihw-6-after.png' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
