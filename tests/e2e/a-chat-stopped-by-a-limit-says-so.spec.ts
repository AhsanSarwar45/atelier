import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { command, openChatTab } from './fixture-held';

/**
 * The word a chat wears in the list when the provider refused its turn.
 *
 * The manager, with the chat open and the notice on its own page saying he had
 * hit a session limit and naming the hour it lifts: "in the sidebar, it doesn't
 * show 'limit reached status' and isntead shows 'failed'". Two readings of one
 * chat, disagreeing on the same screen, because every failed turn published
 * `errored` / `Failed` whatever had gone wrong.
 *
 * A session limit cannot be reached on demand — it needs the account's real
 * allowance to be spent — so the refusal driven here is the other one this
 * stack can produce for real: the run's provider config is a scratch directory
 * of its own with nobody signed in, so a prompt comes back a genuine ACP
 * failure over the real transport. That is the same path, the same code and the
 * same fault; only the condition differs, and which word each condition gets is
 * held where the words are (`provider_messages.rs`, and the test that keeps its
 * vocabulary in step with the screen's).
 *
 * Before this fix the chip on that row read `Failed`. It reads the condition
 * now (bw-d516).
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-chat-stopped-by-a-limit-says-so.spec.ts
 */

const SHOTS = join(process.cwd(), 'tests', 'results');
const OWN_PROJECT_DIR = join(__dirname, '..', '.limit-word-run');

/** Starting an agent and hearing back from it is a process launch. */
const HELLO_MS = 120_000;

async function aProjectOfItsOwn(request: APIRequestContext) {
  const path = join(OWN_PROJECT_DIR, randomUUID());
  mkdirSync(path, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'A chat the provider refused', path },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };
  return {
    project,
    async gone() {
      await request.delete(`/api/projects/${project.id}`);
      rmSync(path, { recursive: true, force: true });
    },
  };
}

test('a chat the provider refused wears the reason, not a bare failure', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { project, gone } = await aProjectOfItsOwn(request);

  try {
    const started = await command(request, {
      type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude',
    });
    expect(started.ok, `could not start a chat: ${started.body}`).toBe(true);
    const id = started.said.id!;

    const spoke = await command(request, {
      type: 'prompt.send', sessionId: id, text: 'Reply with the single word OK and nothing else.',
    });
    expect(spoke.ok, `could not speak to the chat: ${spoke.body}`).toBe(true);

    await openChatTab(page, project);
    const chip = page.locator(`[data-row-key="${id}"] [data-testid="row-pill"]`).first();
    await expect(chip).toBeVisible({ timeout: HELLO_MS });

    // Settled: the chip stops moving once the turn is over, one way or another.
    await expect
      .poll(async () => ((await chip.textContent()) ?? '').trim(), { timeout: HELLO_MS })
      .not.toMatch(/thinking|working|starting|coming back/i);

    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({
      path: join(SHOTS, process.env.LIMIT_WORE_BEFORE ? 'bw-d516-word-before.png' : 'bw-d516-word-after.png'),
      fullPage: false,
    });

    // The whole of it: the row says what stopped the chat. `Failed` is the
    // word for a failure nothing could name, and this one has a name.
    const word = ((await chip.textContent()) ?? '').trim();
    // eslint-disable-next-line no-console
    console.log('THE ROW SAYS:', JSON.stringify(word));
    expect(word).not.toMatch(/^failed$/i);
  } finally {
    await gone();
  }
});
