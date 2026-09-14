import { expect, test } from '@playwright/test';

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { aChatSomebodyElseIsIn, backend } from './fixture-held';

test.setTimeout(120_000);

test('a sidebar chat can be renamed and its ID copied from the pointer menu', async ({ page, request }) => {
  const dir = join(__dirname, '..', '.held-run', `row-actions-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const made = await request.post(`${backend()}/api/projects`, { data: { name: 'chat-row-actions', path: dir } });
  expect(made.status()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };
  const external = aChatSomebodyElseIsIn(project.path, 'Give this chat a useful name.');

  try {
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const outside = page.locator(`[data-testid="restore-row"][data-external-id="${external.id}"]`);
    await outside.waitFor({ timeout: 60_000 });

    // Import it into Atelier without waking an agent, then return to the list.
    await outside.getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: 60_000 });
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-external-id="${external.id}"]`);
    await row.waitFor({ timeout: 60_000 });
    await expect.poll(async () => row.getAttribute('data-row-key')).not.toMatch(/^ext:/);

    await row.click({ button: 'right' });
    await expect(page.getByTestId('chat-context-menu')).toBeVisible();
    await expect(page.getByTestId('chat-menu-rename')).toBeEnabled();
    const proof = join(process.env.WORKBENCH_E2E_RUN!, 'chat-row-actions.png');
    await page.screenshot({ path: proof });

    await page.getByTestId('chat-menu-rename').click();
    await page.getByLabel('Chat name').fill('Release planning');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(row.getByText('Release planning')).toBeVisible();

    await page.reload();
    await expect(page.locator(`[data-testid="restore-row"][data-external-id="${external.id}"]`).getByText('Release planning')).toBeVisible({ timeout: 60_000 });
  } finally {
    external.forget();
    await request.delete(`${backend()}/api/projects/${project.id}`);
    rmSync(dir, { recursive: true, force: true });
  }
});
