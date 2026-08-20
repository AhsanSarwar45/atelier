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
 * The wait is a Python sleep rather than the shell's own, because a rule on
 * this machine blocks a bare `sleep` and the helper inherits it: told to sleep,
 * it spent its minute working around the refusal instead of waiting, and the
 * picture this case leaves behind carried a red failed command that had nothing
 * to do with what is being proved (measured 2026-08-20).
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

/**
 * How long the helper in the panel case is told to wait. Longer than the one
 * above, because the panel is read while it is still working and everything
 * else in that turn has to have happened first.
 */
const HELPER_WAITS_LONGER = 120;

/** How long the command left in the background is told to run. */
const LEFT_RUNNING = 240;

/** The states that mean a piece of sent-off work is over. */
const OVER = ['done', 'failed', 'stopped'];

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
      'First write one short sentence of your own saying you are about to send a helper off. ' +
        'Then use the Task tool exactly once to launch one general-purpose subagent, and do no work yourself. ' +
        'Tell that subagent, in its prompt, to do these four things in order: ' +
        'first write one sentence saying what it is about to do; ' +
        `then run the shell command "python3 -c 'import time; time.sleep(${HELPER_WAITS})'" ` +
        'in the foreground, waiting for it, and do not put it in the background; ' +
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
    // to a helper that no helper said. Read from the sentence it was told to
    // write BEFORE it delegated, because what it says afterwards is not its to
    // decide — asked to answer one word when its helper came back, one run in
    // four said nothing at all and the case waited five minutes for a sentence
    // that was never coming (measured 2026-08-20).
    await expect(page.locator('[data-testid="assistant-message"]:not([data-sent-by])').first()).toBeVisible();

    // Taken while the helper is still working, because that is the picture
    // this case is about: a call still running, the helper's own sentences
    // under it, and a line saying what it is doing now.
    await page.screenshot({ path: `${SHOTS}/chat-agent-own-words.png`, fullPage: false });

    // Stopped when the case is over, so a run leaves no agent behind.
    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: chat } });
  });

  /**
   * The panel beside the conversation, with three different kinds of sent-off
   * work on it at once.
   *
   * The order in the prompt is the order it has to be in: a command left in the
   * background does not block, a small run of agents finishes while the chat
   * waits, and the helper is sent last and told to wait — so the picture this
   * leaves behind is one row still running, one parked in the background and
   * one finished and quiet, which is the whole claim.
   *
   * The three kinds are asked for by name because they arrive by three
   * different roads inside the kit: a helper from the call that sent it, a
   * background command from the level list only (it was never a call of this
   * chat's own), and a run of agents from its own task messages. A case that
   * sent three helpers would prove one road three times.
   */
  test('a panel of everything the chat sent away', async ({ page, request }) => {
    // The width this is claimed at: the panel lives in the right column, and
    // the right column is closed on a narrow screen.
    await page.setViewportSize({ width: 1440, height: 900 });
    const chat = await freshChat(request, page);
    await say(
      request,
      chat,
      'Do exactly these three things, in this order, and do no other work of your own. ' +
        `First, run the shell command "python3 -c 'import time; time.sleep(${LEFT_RUNNING})'" in the BACKGROUND ` +
        'and do not wait for it. ' +
        'Second, use a workflow with exactly two agents, each of them told only to reply with the single word ONE. ' +
        'Keep that workflow as small as it can possibly be. ' +
        'Third, use the Task tool exactly once to launch one general-purpose subagent, and tell it in its prompt to ' +
        `run "python3 -c 'import time; time.sleep(${HELPER_WAITS_LONGER})'" in the foreground, wait for it, ` +
        'and then reply with the single word DONE. ' +
        'When that subagent comes back, reply with the single word FINISHED and nothing else.',
    );

    // Three rows at once, one of them over and one of them still going, which
    // is the picture — and it only exists while the helper sent last is still
    // working. Waited for as one condition rather than three, because each of
    // them alone is true at moments when the picture is not there.
    const rows = page.locator('[data-testid="sent-away-row"]');
    await expect
      .poll(
        async () => {
          const states = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-state') ?? ''));
          return {
            rows: states.length,
            over: states.some((s) => OVER.includes(s)),
            going: states.some((s) => !OVER.includes(s)),
          };
        },
        {
          message: 'the panel never carried three pieces of sent-off work with one over and one still going',
          timeout: DELEGATED_MS,
        },
      )
      .toMatchObject({ rows: 3, over: true, going: true });

    const drawn = await rows.evaluateAll((els) =>
      els.map((el) => ({
        kind: el.getAttribute('data-kind'),
        state: el.getAttribute('data-state'),
        what: (el.querySelector('[data-testid="sent-away-what"]') as HTMLElement | null)?.innerText.trim() ?? '',
        model: (el.querySelector('[data-testid="sent-away-model"]') as HTMLElement | null)?.innerText.trim() ?? '',
        forHowLong: (el.querySelector('[data-testid="sent-away-for"]') as HTMLElement | null)?.innerText.trim() ?? '',
        spend: (el.querySelector('[data-testid="sent-away-spend"]') as HTMLElement | null)?.innerText.trim() ?? '',
        doing: (el.querySelector('[data-testid="sent-away-doing"]') as HTMLElement | null)?.innerText.trim() ?? '',
        result: (el.querySelector('[data-testid="sent-away-result"]') as HTMLElement | null)?.innerText.trim() ?? '',
      })),
    );
    const said = JSON.stringify(drawn, null, 2);

    // Three different kinds of work, not the same kind three times.
    expect(new Set(drawn.map((r) => r.kind)).size, `every row is the same kind of work: ${said}`).toBeGreaterThanOrEqual(
      3,
    );

    // Every row says what it is, how long it has been going and what it has
    // spent. A model is asked of the rows that run one: a shell command left in
    // the background has no model to name, and saying one would be a lie.
    for (const row of drawn) {
      expect(row.what, `a row with nothing on it: ${said}`).not.toBe('');
      expect(row.forHowLong, `a row with no clock: ${said}`).toMatch(/\d+[smh]/);
      expect(row.spend, `a row with no spend: ${said}`).toMatch(/\d/);
    }
    // The model is asked of the helper, which is the row that runs one and the
    // row this was asked for. Measured 2026-08-20: the kit names no model for a
    // command left running (it runs none), and none for a scripted run either
    // (each of ITS agents has one; the run itself does not) — so asking those
    // rows for a model would be asking them to invent one.
    expect(
      drawn.filter((r) => r.kind === 'helper').every((r) => r.model !== ''),
      `the helper does not say which model it runs: ${said}`,
    ).toBe(true);

    // One of them is over — and is quiet about the present tense while keeping
    // what it answered — while another is still going.
    const over = drawn.filter((r) => OVER.includes(r.state ?? ''));
    expect(over.every((r) => r.doing === ''), `a finished row is still saying what it is doing: ${said}`).toBe(true);
    expect(over.every((r) => r.result !== ''), `a finished row threw its answer away: ${said}`).toBe(true);
    // Nothing went grey the moment it was sent: a row is over because the work
    // ended, never because the kit acknowledged the launch (bw-7ks.22.3).
    expect(over.every((r) => r.forHowLong !== '0s'), `a row finished having taken no time at all: ${said}`).toBe(true);

    const rail = page.getByTestId('chat-right-rail');
    await expect(rail).toHaveAttribute('data-open', 'true');
    await page.screenshot({ path: `${SHOTS}/chat-sent-away.png`, clip: (await rail.boundingBox())! });

    // Stopped when the case is over, so a run leaves no agent behind — and no
    // command of its own left running in the background.
    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: chat } });
  });
});
