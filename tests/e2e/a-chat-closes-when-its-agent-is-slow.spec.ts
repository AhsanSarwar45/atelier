import { expect, test, type APIRequestContext } from '@playwright/test';

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { backend, command, openChatTab, processesOf } from './fixture-held';

/**
 * Closing a chat whose agent is slow to let go (bw-lid06).
 *
 * Close used to wait for the agent's own answer with no limit. On a busy
 * computer an agent can take far longer than the browser waits, so Close said
 * "no answer from the app" and the chat stayed open. It now waits as long as
 * Stop does, then ends the agent itself.
 *
 * The scripted agent here takes a minute to answer `session/close`:
 *
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" \
 *   BEADS_E2E_ACP_CLOSE_MS=60000 \
 *   scripts/workbench-e2e.sh tests/e2e/a-chat-closes-when-its-agent-is-slow.spec.ts
 */

test.skip(
  !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters')
    || Number(process.env.BEADS_E2E_ACP_CLOSE_MS ?? 0) < 30_000,
  'needs the scripted ACP agent slow to close; run with BEADS_E2E_ACP_CLOSE_MS=60000',
);

const OWN_PROJECT_DIR = join(__dirname, '..', '.held-run');

/** Stop's own wait and its backstop, and some room for a busy database. */
const CLOSED_WITHIN_MS = 15_000;

async function aProject(request: APIRequestContext) {
  const dir = join(OWN_PROJECT_DIR, `slow-close-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const made = await request.post(`${backend()}/api/projects`, { data: { name: 'held-slow-close', path: dir } });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  const project = (await made.json()) as { id: string; path: string };
  return {
    ...project,
    remove: async () => {
      await request.delete(`${backend()}/api/projects/${project.id}`);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test.describe('closing a chat whose agent is slow to answer', () => {
  test.describe.configure({ timeout: 300_000 });

  test('closes in seconds, says nothing went wrong, and ends the agent', async ({ page, request }) => {
    const project = await aProject(request);
    try {
      const started = await command(request, {
        type: 'session.start',
        projectId: project.id,
        projectPath: project.path,
        brand: 'claude',
      });
      expect(started.ok, `could not start a chat: ${started.body}`).toBe(true);
      const id = started.said.id!;

      await expect.poll(() => processesOf(id).length, { timeout: 60_000 }).toBeGreaterThan(0);
      await openChatTab(page, project);
      const row = page.locator(`[data-testid="restore-row"][data-row-key="${id}"]`);
      await row.waitFor({ timeout: 60_000 });
      await row.hover();
      await row.getByTestId('row-close').click();

      const asked = Date.now();
      await page.getByTestId('close-chat-confirm').click();
      await expect(page.getByTestId('close-chat-dialog')).toHaveCount(0, { timeout: CLOSED_WITHIN_MS });
      const took = Date.now() - asked;
      test.info().annotations.push({ type: 'close took', description: `${took} ms` });

      await expect(page.getByTestId('close-chat-error')).toHaveCount(0);
      await expect.poll(async () => row.getAttribute('data-state'), { timeout: 30_000 }).toBe('dormant');

      // And the agent that never answered is gone, not left running.
      await expect.poll(() => processesOf(id), { timeout: 30_000 }).toEqual([]);
    } finally {
      await project.remove();
    }
  });
});
