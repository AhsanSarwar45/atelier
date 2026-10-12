import { expect, test } from '@playwright/test';

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { backend, command, openChatTab } from './fixture-held';

/**
 * Pictures of the close chat window with a deep process tree, on a desktop and
 * on a phone (bw-5etd7). The list of what is running is a fixed answer, so the
 * window always has the same tree to draw: an agent with a test run under it,
 * a dev server whose shell has gone, and a container.
 *
 *   scripts/workbench-e2e.sh tests/e2e/close-chat-tree-shots.spec.ts
 */
const SHOTS = join(__dirname, '..', 'results');
const OWN_PROJECT_DIR = join(__dirname, '..', '.held-run');

const RUNNING = {
  processes: [
    { pid: 4120, parentPid: 1, name: 'claude-agent-acp', command: 'node /usr/lib/node_modules/@zed-industries/claude-agent-acp/dist/index.js', bytes: 180_000_000, startTime: 1, role: 'agent', closesWithChat: true },
    { pid: 4121, parentPid: 4120, name: 'claude', command: 'claude --output-format stream-json --verbose', bytes: 420_000_000, startTime: 1, role: 'agent', closesWithChat: true },
    { pid: 4188, parentPid: 4121, name: 'bash', command: 'bash -c npm test -- --watch=false', bytes: 4_000_000, startTime: 2, role: 'subprocess', closesWithChat: true },
    { pid: 4190, parentPid: 4188, name: 'node', command: 'node node_modules/.bin/vitest run --reporter=verbose', bytes: 610_000_000, startTime: 2, role: 'subprocess', closesWithChat: true },
    { pid: 5301, parentPid: 1, name: 'npm', command: 'npm run dev -- --port 4173', bytes: 60_000_000, startTime: 7, role: 'subprocess', closesWithChat: false },
    { pid: 5302, parentPid: 5301, name: 'node', command: 'node node_modules/.bin/next dev --port 4173 --turbo', bytes: 1_300_000_000, startTime: 8, role: 'subprocess', closesWithChat: false },
    { pid: 5310, parentPid: 5302, name: 'next-server', command: 'next-server (v15.1.0)', bytes: 2_100_000_000, startTime: 9, role: 'subprocess', closesWithChat: false },
  ],
  containers: [{ id: 'abc123def456', name: 'shop-postgres-1', image: 'postgres:16-alpine', project: 'shop' }],
};

test('the close chat window with a process tree, desktop and phone', async ({ page, request }) => {
  test.setTimeout(300_000);
  const dir = join(OWN_PROJECT_DIR, `tree-shots-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const made = await request.post(`${backend()}/api/projects`, { data: { name: 'Atelier', path: dir } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };

  try {
    const started = await command(request, { type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' });
    expect(started.ok, started.body).toBe(true);
    const id = started.said.id!;
    await page.route('**/running', (route) => route.fulfill({ json: RUNNING }));

    await openChatTab(page, project);
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${id}"]`);
    await row.waitFor({ timeout: 60_000 });
    await row.hover();
    await row.getByTestId('row-close').click();
    const dialog = page.getByTestId('close-chat-dialog');
    await expect(page.locator('[data-testid="close-chat-line"]').first()).toBeVisible();
    await page.waitForTimeout(500);
    await dialog.screenshot({ path: join(SHOTS, 'close-tree-desktop.png') });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS, 'close-tree-phone.png') });
    const lines = page.getByTestId('close-chat-line');
    for (let i = 0; i < (await lines.count()); i++) {
      const fits = await lines.nth(i).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      expect.soft(fits, `line ${i} overflows on a phone`).toBe(true);
    }
    // Every branch opened, so the deepest line is measured on a phone too.
    for (;;) {
      const shut = page.locator('[data-testid="close-chat-line"][aria-expanded="false"] button').first();
      if (!(await shut.count())) break;
      await shut.click();
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, 'close-tree-phone-open.png') });
    for (let i = 0; i < (await lines.count()); i++) {
      const fits = await lines.nth(i).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      expect.soft(fits, `opened line ${i} overflows on a phone`).toBe(true);
    }
    await page.getByTestId('close-chat-cancel').click();
  } finally {
    await request.delete(`${backend()}/api/projects/${project.id}`);
    rmSync(dir, { recursive: true, force: true });
  }
});
