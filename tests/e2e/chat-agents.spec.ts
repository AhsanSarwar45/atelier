import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The agents a chat sends off, seen from the chat.
 *
 * This one costs money and minutes: it starts a real chat, tells it to send one
 * helper away, and watches what comes back. There is no other way to prove it —
 * a helper's words only exist because the kit was asked to forward them, and a
 * written record proves the reading path, not the asking (bw-7ks.22.2).
 *
 * The helper is made to wait on purpose, because the line saying what it is
 * doing now is asked of its own conversation about twice a minute: a helper that
 * finishes in five seconds never produces one.
 *
 * It runs on an instance built from THIS worktree, because what it proves is
 * the driver's own reading of what the kit sends — the installed instance runs
 * the sidecar from the main checkout and would prove yesterday's code.
 *
 * The helper is told to say a sentence on the way past, because a helper that
 * only runs commands sends no words for anything to draw: what it finally
 * answers comes back as the call's result, and the sentences this case is about
 * are the ones it writes BETWEEN its commands. Measured twice, 2026-08-20: a
 * helper asked only to run a command and answer produced one forwarded sentence
 * on the first run and none on the second.
 *
 * Reasoning is not asserted here, and that is a limit of the machine rather
 * than a gap: asked for a thinking budget, this account's answers come back
 * with the reasoning withheld — token counts and no words — so a block of
 * thinking with words in it cannot be produced on demand. That the reasoning is
 * kept under the call that sent it is proved in the unit tests, down both the
 * live tail and a replay.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-agents.spec.ts
 */

/** Where a run leaves its proof. */
const SHOTS = 'tests/results';

/** Starting an agent is a process launch. */
const HELLO_MS = 120_000;

/** Sending a helper away, hearing it out, and hearing it finish. */
const DELEGATED_MS = 300_000;

/**
 * How long the helper is told to wait. The brand forks its conversation for a
 * present-tense line about every thirty seconds, so this has to outlast one.
 */
const HELPER_WAITS = 45;

/** A folder of its own, so this case never runs an agent in someone's work. */
const FIXTURE = join(__dirname, '..', '.workbench-run-agents');

/**
 * A project of this run's own, marked as a test project so it stays off the
 * owner's dashboard and is swept up rather than living on his machine.
 */
async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const found = listed.find((p) => p.path === FIXTURE);
  if (found) return found;
  const made = await request.post('/api/projects', {
    data: { name: 'workbench-agents', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/** A chat of its own for this case, allowed to run tools without asking. */
async function freshChat(request: APIRequestContext, page: Page): Promise<string> {
  const project = await fixtureProject(request);

  const started = (await (
    await request.post('/api/workbench/command', {
      // Asking about each tool would stop the run on a permission card, and
      // what is under test is what comes back from a helper, not the card.
      data: {
        type: 'session.start',
        projectId: project.id,
        projectPath: project.path,
        brand: 'claude',
        permissionMode: 'bypassPermissions',
      },
    })
  ).json()) as { id: string };

  await page.goto(`/project?id=${project.id}&tab=chat&chat=${started.id}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
  return started.id;
}

async function say(request: APIRequestContext, sessionId: string, text: string): Promise<void> {
  const answer = await request.post('/api/workbench/command', {
    data: { type: 'prompt.send', sessionId, text },
  });
  expect(answer.ok(), `the chat would not take the prompt: ${answer.status()}`).toBe(true);
}

test.describe('the agents a chat sends off', () => {
  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
  });
  test.describe.configure({ timeout: 600_000 });

  /**
   * A test project is left off the plain list, which is the list the project
   * page itself reads — so this page asks for them too, and a real visitor
   * typing the same address still sees none (as workbench.spec.ts does).
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('a helper’s own words draw under the call that sent it', async ({ page, request }) => {
    const chat = await freshChat(request, page);
    await say(
      request,
      chat,
      'Use the Task tool exactly once to launch one general-purpose subagent, and do no work yourself. ' +
        'Tell that subagent, in its prompt, to do these four things in order: ' +
        'first write one sentence saying what it is about to do; ' +
        `then run the shell command "sleep ${HELPER_WAITS}"; ` +
        'then write one sentence saying whether the wait worked; then reply with the single word DONE. ' +
        'When it comes back, reply with the single word FINISHED and nothing else.',
    );

    // The call that sent it, while it is still going. Everything else is
    // checked against THIS row, so nothing about the nesting is guessed.
    const sender = page.locator('[data-testid="tool-row"][data-tool-status="running"]').first();
    await sender.waitFor({ timeout: DELEGATED_MS });
    const sentBy = await sender.getAttribute('data-tool-id');
    expect(sentBy, 'the running call has no id').toBeTruthy();

    // A line on that row saying what the helper is doing NOW, which is the only
    // thing on the screen while it waits. Read first, because it belongs to a
    // call that is running and is gone once the call is not.
    const doing = sender.getByTestId('tool-doing-now');
    await expect
      .poll(async () => ((await doing.count()) > 0 ? (await doing.innerText()).trim() : ''), {
        message: 'the row that sent the helper never said what it was doing',
        timeout: DELEGATED_MS,
      })
      .not.toBe('');

    // The helper's own sentences — the whole point. Nothing about the call they
    // came from is guessed either: the row they hang off is named on the message.
    const sentences = page.locator(`[data-testid="assistant-message"][data-sent-by="${sentBy}"]`);
    await sentences.first().waitFor({ timeout: DELEGATED_MS });

    // Under it, not merely near it: the sending row comes first in the page.
    const order = await page.evaluate((id) => {
      const row = document.querySelector(`[data-tool-id="${id}"]`)!;
      const said = document.querySelector(`[data-testid="assistant-message"][data-sent-by="${id}"]`)!;
      return row.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before';
    }, sentBy);
    expect(order, 'the helper spoke above the call that sent it').toBe('after');

    // And the chat's own words are still the chat's own: nothing was attributed
    // to a helper that no helper said.
    expect(
      await page.locator('[data-testid="assistant-message"]:not([data-sent-by])').count(),
      'the agent you are talking to said nothing of its own',
    ).toBeGreaterThan(0);

    await page.screenshot({ path: `${SHOTS}/chat-agent-own-words.png`, fullPage: false });

    // Stopped when the case is over, so a run leaves no agent behind.
    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: chat } });
  });
});
