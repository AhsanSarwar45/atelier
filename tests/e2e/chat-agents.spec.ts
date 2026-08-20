import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { makeFixtureProject, PARENT_CARD } from './fixture-board';
import {
  CHAT_SAID,
  HELPER_AGENT,
  HELPER_ANSWERED,
  HELPER_BRIEF,
  HELPER_SAID,
  SENT_OFF_CALL,
  writeChatWithHelper,
} from './fixture-record';
import { restartInstance } from './restart';

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

/** Where the read-back case builds a project with a board of its own. */
const RECORD_RUN = join(__dirname, '..', '.workbench-run-record');
const RECORD_PROJECT = join(RECORD_RUN, 'project');

/** And where the spend case builds its own, for a chat that sent three off. */
const SPEND_RUN = join(__dirname, '..', '.workbench-run-spend');
const SPEND_PROJECT = join(SPEND_RUN, 'project');

/** And where the case that watches a chat send an agent off builds its own. */
const GROWS_RUN = join(__dirname, '..', '.workbench-run-grows');
const GROWS_PROJECT = join(GROWS_RUN, 'project');

/**
 * A project of this run's own, marked as a test project so it stays off the
 * owner's dashboard and is swept up rather than living on his machine.
 *
 * Asked for, not made: the cases in this file run at the same time and four of
 * them share one project, so two of them look, both find nothing, and both make
 * it. Whoever lost that race died on the database refusing a second project at
 * the same path — before it had drawn anything, and about a piece of scaffolding
 * rather than about the screen it was written for (bw-7ks.22.21).
 */
async function projectAt(
  request: APIRequestContext,
  name: string,
  path: string,
): Promise<{ id: string; path: string }> {
  const there = async (): Promise<{ id: string; path: string } | undefined> => {
    const listed = (await (await request.get('/api/projects?include_test=true')).json()) as {
      id: string;
      path: string;
    }[];
    return listed.find((p) => p.path === path);
  };
  const found = await there();
  if (found) return found;
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  if (made.status() === 201) return (await made.json()) as { id: string; path: string };
  // Somebody else made it between the look and the making. Theirs is as good as
  // ours: it is the same path, registered the same way.
  const said = await made.text();
  const raced = await there();
  expect(raced, `no project at ${path}, and it could not be made: ${said}`).toBeTruthy();
  return raced!;
}

async function fixtureProject(request: APIRequestContext): Promise<{ id: string; path: string }> {
  return projectAt(request, 'workbench-agents', FIXTURE);
}

/**
 * A chat of its own for this case, allowed to run tools without asking.
 *
 * Except where the card IS the thing under test: one case asks for the asking
 * mode by name, because a question an agent raised for itself only exists in a
 * chat that asks.
 */
async function freshChat(
  request: APIRequestContext,
  page: Page,
  permissionMode: 'bypassPermissions' | 'default' = 'bypassPermissions',
): Promise<string> {
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
        permissionMode,
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
  // One at a time. Four of these start a real agent, and one of those starts a
  // small run of agents and a helper of its own; run all at once against one
  // account they queue behind each other and time out on a wait that passes in
  // under a minute when two run side by side (measured 2026-08-20: seven at
  // once, two cases dead at five minutes; the same two together, 1.0m and 1.3m,
  // both green). The rest of the suite stays parallel — this file is the one
  // that costs money and minutes (bw-7ks.22.21).
  test.describe.configure({ mode: 'default', timeout: 600_000 });

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
    // working. Waited for as one condition rather than four, because each of
    // them alone is true at moments when the picture is not there.
    //
    // The helper's model is part of what is waited for, not something read off
    // afterwards: a row appears the instant the call that sent it does, and its
    // model arrives later, with the helper's first words. Sampling the rows the
    // moment three of them coexist catches the helper before it has spoken and
    // fails saying it names no model (bw-7ks.22.20).
    const rows = page.locator('[data-testid="sent-away-row"]');
    await expect
      .poll(
        async () => {
          const seen = await rows.evaluateAll((els) =>
            els.map((el) => ({
              state: el.getAttribute('data-state') ?? '',
              kind: el.getAttribute('data-kind') ?? '',
              model: (el.querySelector('[data-testid="sent-away-model"]') as HTMLElement | null)?.innerText.trim() ?? '',
            })),
          );
          const helpers = seen.filter((r) => r.kind === 'helper');
          return {
            rows: seen.length,
            over: seen.some((r) => OVER.includes(r.state)),
            going: seen.some((r) => !OVER.includes(r.state)),
            helpersNameTheirModel: helpers.length > 0 && helpers.every((r) => r.model !== ''),
          };
        },
        {
          message: 'the panel never carried three pieces of sent-off work with one over, one still going and the helper naming its model',
          timeout: DELEGATED_MS,
        },
      )
      .toMatchObject({ rows: 3, over: true, going: true, helpersNameTheirModel: true });

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

  /**
   * The lines the conversation itself writes about work the chat sent away,
   * read exactly as a reader has them: nothing switched on, nothing clicked.
   *
   * The panel says three helpers are running; only the conversation says the
   * second one went off between the two commands he is looking at. So the lines
   * are the record and the panel is a reading of it, and a record filed under
   * the machine's own breathing — which starts switched off — is a chat that
   * delegated its whole turn reading as a chat that fell silent (bw-7ks.22.6).
   *
   * The helper is told to wait, because a foreground command that takes a
   * moment is what the kit opens a task of its own for: the count below is only
   * a claim about whose work is announced if the helper's work is announceable
   * in the first place. What the four other kinds of line say — retrying,
   * failed, given up on — is held next door in the sidecar's own suite, where
   * a failure and a busy service can be produced on demand and here they cannot.
   */
  test('the lines about work it sent away are on the page with nothing switched on', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const chat = await freshChat(request, page);
    await say(
      request,
      chat,
      'Use the Task tool exactly once to launch one general-purpose subagent, and do no work yourself. ' +
        'Tell that subagent, in its prompt, to run the shell command ' +
        `"python3 -c 'import time; time.sleep(${HELPER_WAITS})'" in the foreground, wait for it, ` +
        'and then reply with the single word DONE. ' +
        'When it comes back, reply with the single word FINISHED and nothing else.',
    );

    // Waited out to the end of the turn: the finishing line is the second half
    // of what this case is about, and it does not exist until the helper is home.
    await expect
      .poll(
        async () =>
          await page.locator('[data-testid="note-row"][data-note-kind="system/task_notification"]').count(),
        { message: 'the chat never said its helper had finished', timeout: DELEGATED_MS },
      )
      .toBeGreaterThan(0);

    const lines = await page
      .locator('[data-testid="note-row"]')
      .evaluateAll((els) =>
        els.map((el) => ({
          kind: el.getAttribute('data-note-kind') ?? '',
          family: el.getAttribute('data-family') ?? '',
          text: (el.querySelector('[data-testid="note-toggle"]') as HTMLElement | null)?.innerText.trim() ?? '',
        })),
      );
    const said = JSON.stringify(lines, null, 2);

    // One line saying it went and one saying it came home — and exactly one of
    // each, because the helper opened a piece of work of its own and that is
    // the helper's news, not this chat's (bw-7ks.22.18).
    const went = lines.filter((l) => l.kind === 'system/task_started');
    const home = lines.filter((l) => l.kind === 'system/task_notification');
    expect(went.length, `not one line saying work was sent off: ${said}`).toBe(1);
    expect(home.length, `not one line saying it finished: ${said}`).toBe(1);
    expect(went[0].text, `the line does not say what was sent off: ${said}`).toMatch(/Sent off: \S/);

    // And they are drawn, which is the claim: the filter was never touched, so
    // what is on the page is what a reader who has never opened it has.
    expect(
      [...went, ...home].every((l) => l.family !== 'breathing'),
      `a line about sent-off work is filed as the machine's own breathing: ${said}`,
    ).toBe(true);

    await page.screenshot({ path: `${SHOTS}/chat-sent-away-lines.png`, fullPage: false });

    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: chat } });
  });

  /**
   * One agent's own conversation, opened from its row — while it works, and
   * again after the program has been stopped and started.
   *
   * The restart is the whole second half. A pane built from what this browser
   * happened to watch go past would pass the first half and be empty on the
   * second, and that is exactly the fault this job is fixing everywhere else:
   * a chat read back disagreeing with the same chat watched live. So the same
   * agent is opened twice and the second reading is checked against the first.
   */
  test('opens one agent’s own conversation from its row, and again after a restart', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const chat = await freshChat(request, page);
    const project = await fixtureProject(request);
    await say(
      request,
      chat,
      'Use the Task tool exactly once to launch one general-purpose subagent, and do no work yourself. ' +
        'Tell that subagent, in its prompt, to do these four things in order: ' +
        'first write one sentence saying what it is about to do; ' +
        `then run the shell command "python3 -c 'import time; time.sleep(${HELPER_WAITS})'" ` +
        'in the foreground, waiting for it, and do not put it in the background; ' +
        'then write one sentence saying whether the wait worked; then reply with the single word DONE. ' +
        'When it comes back, reply with the single word FINISHED and nothing else.',
    );

    // ---- opened while it is still working -------------------------------
    const row = page.locator('[data-testid="sent-away-row"][data-kind="helper"]').first();
    await row.waitFor({ timeout: DELEGATED_MS });
    const agent = await row.getAttribute('data-agent');
    expect(agent, 'the helper’s row has no id').toBeTruthy();

    await row.click();
    const pane = page.getByTestId('agent-view');
    await expect(pane).toHaveAttribute('data-agent', agent!);

    // Its own words, in the pane, while it is still going. Polled rather than
    // asserted once: the pane opens the moment the row exists, which can be
    // before the helper has said anything.
    // Polled on the COMMAND it was told to run, not on a sentence: whether a
    // helper writes one before it starts work is the model's business, and a
    // check that waits for one fails for reasons that are not the app's.
    await expect
      .poll(async () => pane.getByTestId('subagent-tool-row').count(), {
        message: 'the pane never showed anything the helper did',
        timeout: DELEGATED_MS,
      })
      .toBeGreaterThan(0);
    // `subagent-tool-row`, because every row in this pane belongs to the agent
    // the pane is about: what a helper did is drawn as a helper's everywhere.
    await expect(pane.getByTestId('subagent-tool-row').first()).toContainText('time.sleep(');
    expect(Number(await pane.getAttribute('data-said'))).toBeGreaterThan(0);
    // What it SAID, kept for after the restart — and only that, never the whole
    // pane: a command's row reads RUNNING under the command and OK once it is
    // done, so a mid-run capture of the pane can never match itself afterwards.
    const live = (await pane.getByTestId('assistant-message').allInnerTexts())
      .map((t) => t.trim())
      .filter(Boolean);

    await page.screenshot({ path: `${SHOTS}/chat-agent-opened.png`, fullPage: false });
    await page.getByTestId('agent-view-close').click();
    await expect(pane).toHaveCount(0);

    // Finished before the program is stopped, so what is read back afterwards
    // is a whole conversation and not one cut off mid-sentence.
    await expect
      .poll(async () => (await row.getAttribute('data-state')) ?? '', {
        message: 'the helper never finished',
        timeout: DELEGATED_MS,
      })
      .toMatch(new RegExp(OVER.join('|')));
    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: chat } });

    // ---- and again, off the record, after the program is restarted -------
    await restartInstance({
      binary: join(__dirname, '..', '..', 'server', 'target', 'debug', 'beads-server'),
      serverPort: Number(process.env.BEADS_WEB_PORT ?? 3018),
      sidecarPort: Number(process.env.BEADS_WORKBENCH_PORT ?? 3019),
      env: process.env,
      healthUrl: `${process.env.BEADS_E2E_URL}/api/workbench/health`,
      logFile: join(process.env.WORKBENCH_E2E_RUN ?? join(__dirname, '..', '.e2e-run'), 'server.log'),
    });

    await page.goto(`/project?id=${project.id}&tab=chat&chat=${chat}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

    // The same agent, by the same id — not merely "a row".
    const again = page.locator(`[data-testid="sent-away-row"][data-agent="${agent}"]`);
    await again.waitFor({ timeout: HELLO_MS });
    await expect(again).toHaveAttribute('data-kind', 'helper');
    await again.click();

    const reopened = page.getByTestId('agent-view');
    await expect(reopened).toHaveAttribute('data-agent', agent!);
    // Everything it said is still there: the same words, and its answer with
    // them. Not "at least something" — the conversation read live, verbatim.
    const kept = (await page.getByTestId('agent-view-said').innerText()).trim();
    for (const words of live) {
      expect(kept, `what the helper said was lost over the restart.\nlive:\n${words}\n\nafter:\n${kept}`).toContain(
        words,
      );
    }
    // And what it DID, not only what it said: the command it ran is on the
    // record too, or the pane read back is half a conversation.
    expect(kept, 'the command the helper ran is missing after the restart').toContain('time.sleep(');
    await expect(page.getByTestId('agent-view-result')).not.toHaveText('');

    // One row on the panel, not two. The helper ran a command of its own, and
    // the kit reports that on the same channel as the chat's own work — drawn
    // there it was a second row owned by nobody. It belongs inside this pane,
    // which is where it is (bw-7ks.22.18).
    await expect(page.getByTestId('sent-away-panel')).toHaveAttribute('data-rows', '1');

    await page.screenshot({ path: `${SHOTS}/chat-agent-opened-again.png`, fullPage: false });
  });

  /**
   * A chat this app never ran, opened off the record afterwards.
   *
   * The case above restarts the program and reads a chat back — but a chat the
   * app DROVE is replayed from its own event log, so it proves the log and
   * never the record. This one is the other reading: a conversation that
   * happened somewhere else, found on disk, whose helper's turns the kit filed
   * in a file of its own beside the record and never in it. Read as the chat's
   * own file alone, that chat sent nothing off — an empty panel, nothing to
   * open, and a card only the helper ever touched on no chat anywhere
   * (bw-7ks.22.7).
   *
   * The record is written rather than earned, because a live agent cannot
   * produce this: every chat a live run makes is a chat this app drove. The
   * shapes are the kit's own, and the reading of them is proved line by line
   * next door in the sidecar's suite; what this case proves is that the app
   * reaches for that file at all, and draws what it finds where a reader
   * expects it.
   *
   * The board is real. The helper runs `bd show` on a card of the fixture's
   * own, and the chat's own turns never name it, so a chip for it on the chat
   * can have come from nowhere but the helper.
   */
  test('a chat read back from the record keeps its agents apart', async ({ page, request }) => {
    // The panel lives in the right column, which is shut on a narrow screen.
    await page.setViewportSize({ width: 1440, height: 900 });
    rmSync(RECORD_RUN, { recursive: true, force: true });
    mkdirSync(RECORD_RUN, { recursive: true });
    makeFixtureProject(RECORD_PROJECT, join(RECORD_RUN, 'reporting'));
    const project = await projectAt(request, 'workbench-record', RECORD_PROJECT);
    const written = writeChatWithHelper({
      cwd: RECORD_PROJECT,
      sessionId: randomUUID(),
      card: PARENT_CARD,
    });

    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: HELLO_MS });

      // Offered like any chat begun elsewhere, and opened for reading by its
      // name — not resumed, because nothing here starts an agent.
      const listed = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
      await listed.waitFor({ timeout: HELLO_MS });
      await listed.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

      // ---- the conversation ------------------------------------------------
      // The chat's own answer is the chat's own.
      const itsOwn = page.locator('[data-testid="assistant-message"]:not([data-sent-by])');
      await expect(itsOwn.filter({ hasText: CHAT_SAID })).toHaveCount(1, { timeout: HELLO_MS });
      // And the helper's words are the helper's, named by the call that sent
      // it — the whole of this item in one line.
      const helperSaid = page.locator(`[data-testid="assistant-message"][data-sent-by="${SENT_OFF_CALL}"]`);
      await expect(helperSaid.filter({ hasText: HELPER_SAID })).toHaveCount(1);
      expect(
        await itsOwn.filter({ hasText: HELPER_SAID }).count(),
        'the helper’s sentence was drawn as the chat’s own',
      ).toBe(0);
      // Under the call that sent it, not merely near it.
      const order = await page.evaluate((id) => {
        const row = document.querySelector(`[data-tool-id="${id}"]`);
        const said = document.querySelector(`[data-testid="assistant-message"][data-sent-by="${id}"]`);
        if (!row || !said) return 'missing';
        return row.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before';
      }, SENT_OFF_CALL);
      expect(order, 'the helper spoke above the call that sent it').toBe('after');

      // ---- the panel -------------------------------------------------------
      await expect(page.getByTestId('sent-away-panel')).toHaveAttribute('data-rows', '1');
      const row = page.locator(`[data-testid="sent-away-row"][data-agent="${HELPER_AGENT}"]`);
      await expect(row).toHaveAttribute('data-kind', 'helper');
      await expect(row).toHaveAttribute('data-state', 'done');
      await expect(row.getByTestId('sent-away-what')).toHaveText(HELPER_BRIEF);
      // What the record states nowhere and the row says anyway: which model it
      // ran, how long it took, and what it spent, all worked out from its own
      // turns (helper-records.ts).
      await expect(row.getByTestId('sent-away-model')).not.toHaveText('');
      await expect(row.getByTestId('sent-away-for')).toHaveText(/\d+[smh]/);
      await expect(row.getByTestId('sent-away-spend')).toHaveText(/\d/);
      await expect(row.getByTestId('sent-away-result')).toContainText(HELPER_ANSWERED);

      // ---- the card only the helper touched --------------------------------
      // Polled: the board is asked about each candidate behind the drawing.
      await expect(page.locator(`[data-testid="bead-chip"][data-bead-id="${PARENT_CARD}"]`).first()).toBeVisible({
        timeout: HELLO_MS,
      });

      await page.screenshot({ path: `${SHOTS}/chat-agents-read-back.png`, fullPage: false });

      // ---- and its own conversation, one click away ------------------------
      await row.click();
      const pane = page.getByTestId('agent-view');
      await expect(pane).toHaveAttribute('data-agent', HELPER_AGENT);
      const said = (await page.getByTestId('agent-view-said').innerText()).trim();
      expect(said, 'the helper’s own sentence is not in its pane').toContain(HELPER_SAID);
      expect(said, 'what the helper DID is not in its pane').toContain(`bd show ${PARENT_CARD}`);
      await expect(page.getByTestId('agent-view-result')).toContainText(HELPER_ANSWERED);
      await page.screenshot({ path: `${SHOTS}/chat-agents-read-back-opened.png`, fullPage: false });
    } finally {
      written.remove();
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  /**
   * What a chat spent, on a chat that delegated most of its work.
   *
   * Written rather than run, and that is the point of it. What a delegated turn
   * costs cannot be checked against a live run: the figures come back different
   * every time, so a case could only ever assert that some number is bigger than
   * some other number. Here every turn's spend is written down, so the chat's
   * own line can be held to the exact sum — the chat's four turns of its own
   * plus the whole of all three helpers — and a reading that quietly dropped
   * the helpers would be off by a number this case names (bw-7ks.22.8).
   *
   * What the kit reports to a LIVE chat already counts what it delegated:
   * measured 2026-08-20, a turn that sent one agent off reported $0.2399167,
   * which is its own $0.232197 plus that agent's $0.007720 exactly, and the
   * kit's own per-model totals name the helper's model separately. The gap this
   * closes is the other one — a chat nobody is driving, which had no spend at
   * all.
   */
  test('the spend on a turn counts the three agents it sent away', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    rmSync(SPEND_RUN, { recursive: true, force: true });
    mkdirSync(SPEND_RUN, { recursive: true });
    makeFixtureProject(SPEND_PROJECT, join(SPEND_RUN, 'reporting'));
    const project = await projectAt(request, 'workbench-spend', SPEND_PROJECT);
    const written = writeChatWithHelper({
      cwd: SPEND_PROJECT,
      sessionId: randomUUID(),
      card: PARENT_CARD,
      sentOff: 3,
    });

    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: HELLO_MS });
      const listed = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
      await listed.waitFor({ timeout: HELLO_MS });
      await listed.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });

      // Three agents on the panel, so the sum below is a sum over three rows
      // and not over an empty list that happened to add up.
      await expect(page.getByTestId('sent-away-panel')).toHaveAttribute('data-rows', '3', { timeout: HELLO_MS });

      // The whole of it: the chat's own turns AND every one of theirs.
      const chip = page.getByTestId('cost-chip');
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('data-kind', 'tokens');
      await expect(chip).toHaveAttribute('data-total', String(written.spend.total));
      // Said as a sum rather than as one number, so a failure says which half
      // went missing: the delegated work is most of this chat's bill.
      expect(written.spend.total, 'the fixture spent nothing on its helpers').toBe(
        written.spend.own + written.spend.helpers,
      );
      expect(written.spend.helpers, 'nothing was delegated, so nothing is being proved').toBeGreaterThan(0);
      // And the chat's own turns alone are not what is on the line.
      expect(Number(await chip.getAttribute('data-total'))).toBeGreaterThan(written.spend.own);

      await page.screenshot({ path: `${SHOTS}/chat-agents-spend.png`, fullPage: false });
    } finally {
      written.remove();
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  /**
   * An agent sent off while the reader is watching a chat somebody else drives.
   *
   * The follower reads the record's tail, and a helper's turns are not in it:
   * the kit files them beside it and puts nothing but the call and the answer in
   * the record itself. So a chat opened for reading grew rows for its own
   * commands and stayed silent about every agent it sent off from then on — the
   * row appeared only if the reader shut the chat and opened it again
   * (bw-7ks.22.19).
   *
   * Written rather than run, because what is being proved is a chat ANOTHER
   * program is driving: a live case here would be this app driving it, which is
   * the path that already worked. The record and the agent's own file are moved
   * in the order the kit moves them — the call first, the agent's own words as
   * it says them, the answer last — so the three things asserted below are
   * three separate arrivals and not one reading of a finished chat.
   */
  test('follows an agent a chat sends off while it is being read', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    rmSync(GROWS_RUN, { recursive: true, force: true });
    mkdirSync(GROWS_RUN, { recursive: true });
    makeFixtureProject(GROWS_PROJECT, join(GROWS_RUN, 'reporting'));
    const project = await projectAt(request, 'workbench-grows', GROWS_PROJECT);
    // A chat that has sent nothing off, so every row on its panel arrived after
    // it was opened.
    const written = writeChatWithHelper({
      cwd: GROWS_PROJECT,
      sessionId: randomUUID(),
      card: PARENT_CARD,
      sentOff: 0,
    });

    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: HELLO_MS });
      const listed = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
      await listed.waitFor({ timeout: HELLO_MS });
      await listed.getByTestId('row-name').click();
      await page.getByTestId('chat-tab').waitFor({ timeout: HELLO_MS });
      // What it said before anyone opened it is here, and nothing was sent away.
      await expect(page.getByTestId('transcript').getByText(CHAT_SAID)).toBeVisible({ timeout: HELLO_MS });
      await expect(page.getByTestId('sent-away-row')).toHaveCount(0);

      // The other program sends one off. Its answer is not in the record yet,
      // which is the shape a record ends in while an agent is working.
      const sent = written.sendsOff('Read the board and report');
      const row = page.locator(`[data-testid="sent-away-row"][data-agent="${sent.agentId}"]`);
      await expect(row, 'the chat grew no row for the agent it sent off').toHaveCount(1, { timeout: HELLO_MS });
      await expect(row).toHaveAttribute('data-kind', 'helper');
      await expect(row.getByTestId('sent-away-what')).toContainText('Read the board and report');
      // Still going: nothing has come back to the chat about it.
      expect(OVER, 'the row was over before its answer reached the chat').not.toContain(
        await row.getAttribute('data-state'),
      );

      // Its own words, into its own file and nowhere near the record — and they
      // arrive under its row without the reader touching anything.
      sent.says(HELPER_SAID);
      await expect(row.getByTestId('sent-away-model'), 'the row never learned which model it runs').toContainText(
        'fable',
        { timeout: HELLO_MS },
      );
      await row.getByTestId('sent-away-open').click();
      const pane = page.getByTestId('agent-view');
      await pane.waitFor({ timeout: HELLO_MS });
      await expect(pane).toHaveAttribute('data-agent', sent.agentId);
      await expect(pane.getByTestId('agent-view-said'), 'the agent’s own turns are not under its row').toContainText(
        HELPER_SAID,
        { timeout: HELLO_MS },
      );
      await page.screenshot({ path: `${SHOTS}/chat-agents-follows.png`, fullPage: false });

      // And the answer coming back to the chat is the row ending, with what it
      // said kept on it.
      sent.answers(HELPER_ANSWERED);
      await expect(pane.getByTestId('agent-view-result')).toContainText(HELPER_ANSWERED, { timeout: HELLO_MS });
      await page.getByTestId('agent-view-close').click();
      await expect
        .poll(async () => row.getAttribute('data-state'), {
          message: 'the row never ended once the chat had its answer',
          timeout: HELLO_MS,
        })
        .toBe('done');
      await expect(row.getByTestId('sent-away-result')).toContainText(HELPER_ANSWERED);
    } finally {
      written.remove();
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  /**
   * Steering one agent the chat sent away, all three tiers of it (§8.2.7).
   *
   * Two of them are direct — the kit is asked about that one piece of work, by
   * its own name — and the third is not: nothing can hand words to an agent
   * that is already running, so what the reader types goes to the chat that
   * sent it, naming which one it is for, and the pane says so. A box that
   * looked like a chat with the agent would be a lie the reader only finds out
   * about when the answer never comes.
   *
   * Run rather than written, for the reason the whole file is: the two direct
   * tiers are the kit's own answer to being asked, and a written record proves
   * the drawing and not the asking. Parking and stopping are asked with two
   * DIFFERENT ids — the task for one, the call that started it for the other —
   * and handing over the wrong one parks the whole turn instead of one agent,
   * which is exactly the mistake a live run catches and a fixture cannot.
   *
   * The helper is told to wait a long time on purpose: everything below happens
   * while it is still working, and a helper that finishes first leaves nothing
   * to steer.
   */
  test('steers one agent it sent away: parks it, relays a word to it, and ends it', async ({ page, request }) => {
    // The panel lives in the right column, and the right column is closed on a
    // narrow screen.
    await page.setViewportSize({ width: 1440, height: 900 });
    const chat = await freshChat(request, page);
    await say(
      request,
      chat,
      'Use the Task tool exactly once to launch one general-purpose subagent, and do no work of your own. ' +
        `Tell that subagent, in its prompt, to run "python3 -c 'import time; time.sleep(${LEFT_RUNNING})'" ` +
        'in the foreground, wait for it, and then reply with the single word DONE. ' +
        'When it comes back, reply with the single word FINISHED and nothing else.',
    );

    const row = page.locator('[data-testid="sent-away-row"][data-kind="helper"]').first();
    await row.waitFor({ timeout: DELEGATED_MS });
    await expect(row.getByTestId('sent-away-steer'), 'a running row carried no controls').toBeVisible();

    // Parked: it runs on, and the turn comes back. Both halves matter — a park
    // that ended it would be a stop, and a park that kept the chat waiting
    // would be nothing at all.
    await row.getByTestId('sent-away-park').click();
    await expect
      .poll(async () => row.getAttribute('data-state'), {
        message: 'the agent never went to the background',
        timeout: DELEGATED_MS,
      })
      .toBe('parked');
    await expect(page.getByTestId('send-button'), 'the chat never got its turn back').toBeVisible({
      timeout: DELEGATED_MS,
    });

    // Words for it, which go to the chat that sent it. Drawn as relayed,
    // because that is what happened to them.
    await row.getByTestId('sent-away-open').click();
    const pane = page.getByTestId('agent-view');
    await pane.waitFor({ timeout: HELLO_MS });
    await pane.getByTestId('agent-view-relay-text').fill('Stop waiting and answer with the word RELAYED.');
    await pane.getByTestId('agent-view-relay-send').click();
    await expect(pane.getByTestId('agent-view-relayed'), 'the pane never said the words had gone anywhere').toHaveAttribute(
      'data-count',
      '1',
      { timeout: DELEGATED_MS },
    );
    await page.screenshot({ path: `${SHOTS}/chat-agents-steer.png`, fullPage: false });
    await pane.getByTestId('agent-view-close').click();

    // Ended, and that one only.
    await row.getByTestId('sent-away-stop').click();
    await expect
      .poll(async () => row.getAttribute('data-state'), {
        message: 'the agent was never ended',
        timeout: DELEGATED_MS,
      })
      .toBe('stopped');

    // The chat itself carried on, which is the difference between stopping one
    // agent and stopping the chat. Asked outright, because a chat that had been
    // killed looks exactly like a quiet one.
    await say(request, chat, 'Reply with the single word ALIVE and nothing else.');
    await expect(
      page.locator('[data-testid="assistant-message"]:not([data-sent-by])').filter({ hasText: 'ALIVE' }).first(),
      'the chat did not survive one of its agents being stopped',
    ).toBeVisible({ timeout: DELEGATED_MS });

    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: chat } });
  });

  /**
   * A question an agent raised for itself, answered on the agent's own row.
   *
   * The kit asks the chat, not the reader, and it names the CALL that asked —
   * so a helper's question arrived looking exactly like the chat's own, in the
   * middle of a conversation the helper is not part of, with nothing saying who
   * wanted it. The reader was answering for somebody they could not see.
   *
   * The one case in this file that runs in the asking mode, because a card is
   * what it is about. Whatever the chat itself asks is allowed on the way past;
   * the card that is waited for is the one carrying an agent's name.
   *
   * The subagent is given two commands rather than one so there is a stretch of
   * work between them: answering the first question puts the row back to
   * working, and a helper with nothing left to do would be finished before the
   * screen could say so.
   */
  test('steers by answering a question one agent raised for itself', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const chat = await freshChat(request, page, 'default');
    await say(
      request,
      chat,
      'Use the Task tool exactly once to launch one general-purpose subagent, and do no work of your own. ' +
        'Tell that subagent, in its prompt, to do these two things in order: ' +
        `first run the shell command "python3 -c 'print(41 + 1)'" and note what it printed; ` +
        `then run "python3 -c 'import time; time.sleep(${LEFT_RUNNING})'" in the foreground and wait for it. ` +
        'When it comes back, reply with the single word FINISHED and nothing else.',
    );

    const open = page.locator('[data-testid="permission-card"][data-ask-state="open"]');
    const fromAnAgent = page.locator('[data-testid="permission-card"][data-ask-state="open"][data-sent-by]');

    // Everything the chat asks for itself is waved through; the run is waiting
    // for the first question that is somebody else's.
    await expect
      .poll(
        async () => {
          if ((await fromAnAgent.count()) > 0) return true;
          try {
            if ((await open.count()) > 0) await open.first().getByTestId('permission-allow_once').click({ timeout: 2000 });
          } catch {
            // It was answered, or resolved itself, between the look and the click.
          }
          return false;
        },
        { message: 'no agent ever raised a question of its own', timeout: DELEGATED_MS },
      )
      .toBe(true);

    const card = fromAnAgent.first();
    const row = page.locator('[data-testid="sent-away-row"][data-kind="helper"]').first();
    await row.waitFor({ timeout: DELEGATED_MS });

    // The card names the agent by its brief — the same words its row carries —
    // so the reader knows who they are answering for.
    const brief = ((await row.getByTestId('sent-away-what').textContent()) ?? '').trim();
    expect(brief, 'the row for the agent that asked has no brief').not.toBe('');
    await expect(card.getByTestId('permission-asked-by')).toContainText(brief);

    // And the row says it is not working: it is waiting on the reader.
    await expect
      .poll(async () => row.getAttribute('data-state'), {
        message: 'the row went on reading as working while it waited to be answered',
        timeout: DELEGATED_MS,
      })
      .toBe('waiting');
    await page.screenshot({ path: `${SHOTS}/chat-agents-steer-asked.png`, fullPage: false });

    // Answered, and it is working again.
    await card.getByTestId('permission-allow_once').click();
    await expect
      .poll(async () => row.getAttribute('data-state'), {
        message: 'the row never went back to working after it was answered',
        timeout: DELEGATED_MS,
      })
      .toBe('running');

    await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId: chat } });
  });
});
