import { expect, test, type APIRequestContext } from '@playwright/test';

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { backend, command, openChatTab } from './fixture-held';

/**
 * The two pictures for the manager's page — a chat list with the pointer on a
 * row, and the same list after that chat is closed — taken on the running app
 * (bw-cnxh, decision D4: the proof of this one is the running app, not a
 * passing test).
 *
 * A case like any other, and it runs with the rest: the pictures are its
 * by-product, so the page can be given new ones by re-running it rather than by
 * somebody driving the app by hand. Two chats, so the reader can see the one
 * being closed against a living one beside it — and can see that the control
 * appears over the clock on the row under the pointer, taking nothing from the
 * name on any of them.
 *
 *   scripts/workbench-e2e.sh tests/e2e/chat-close-shots.spec.ts
 */
const SHOTS = join(__dirname, '..', 'results');
const OWN_PROJECT_DIR = join(__dirname, '..', '.held-run');

async function aChat(request: APIRequestContext, project: { id: string; path: string }, say: string) {
  const started = await command(request, {
    type: 'session.start',
    projectId: project.id,
    projectPath: project.path,
    brand: 'claude',
  });
  expect(started.ok, started.body).toBe(true);
  const id = started.said.id!;
  const spoke = await command(request, { type: 'prompt.send', sessionId: id, text: say });
  expect(spoke.ok, spoke.body).toBe(true);
  return id;
}

test('the chat list, before a closing and after it', async ({ page, request }) => {
  test.setTimeout(300_000);
  const dir = join(OWN_PROJECT_DIR, `shots-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const made = await request.post(`${backend()}/api/projects`, { data: { name: 'Atelier', path: dir } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };

  try {
    await aChat(request, project, 'Say READY and nothing else.');
    const doomed = await aChat(request, project, 'Say OK and nothing else.');

    await openChatTab(page, project);
    const list = page.getByTestId('chat-sidebar');
    const row = page.locator(`[data-testid="restore-row"][data-row-key="${doomed}"]`);
    await row.waitFor({ timeout: 60_000 });
    await row.hover();
    await list.screenshot({ path: join(SHOTS, 'close-before.png') });

    await row.getByTestId('row-close').click();
    await expect.poll(async () => row.getAttribute('data-state'), { timeout: 60_000 }).toBe('dormant');
    await page.mouse.move(0, 0);
    await expect(row.getByTestId('row-pill')).toHaveCount(0, { timeout: 30_000 });
    await list.screenshot({ path: join(SHOTS, 'close-after.png') });
  } finally {
    await request.delete(`${backend()}/api/projects/${project.id}`);
    rmSync(dir, { recursive: true, force: true });
  }
});
