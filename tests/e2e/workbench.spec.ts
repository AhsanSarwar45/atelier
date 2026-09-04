import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { PARENT_CARD, bd, discardFixture, makeFixtureProject } from './fixture-board';
import { openChatTab } from './open-chat-tab';
import { restartInstance } from './restart';
import { quadrantPng } from './fixture-png';

/**
 * Agent workbench end-to-end. Design: docs/agent-workbench.md.
 *
 * Drives a REAL Claude session through the app, so it needs:
 *   - a atelier built from this worktree, with the workbench sidecar,
 *     reachable at BEADS_E2E_URL (default http://localhost:3008);
 *   - the terminal's own Claude sign-in. No API key is set or read.
 *
 * Run through the harness, which builds both halves, isolates the ports and
 * the config homes, and copies the bearer credentials into the run:
 *
 *   BEADS_E2E_LIVE_PROVIDERS=1 scripts/workbench-e2e.sh tests/e2e/workbench.spec.ts
 *
 * Without the flag nothing here can sign in and every case fails on the
 * provider rather than on the app.
 */

/**
 * One directory per test, kept out of Playwright's outputDir (which is wiped at
 * the start of a run). Separate because the tests run in parallel and each one
 * clears its own fixture — a shared directory would have them racing.
 */
const fixtureFor = (name: string) => join(__dirname, '..', `.workbench-run-${name}`);
const SHOTS = join(__dirname, '..', 'results');

/**
 * Where the Claude CLI this run drives keeps its transcripts.
 *
 * `CLAUDE_CONFIG_DIR` is what the CLI itself reads, and the harness points it
 * at a directory inside the run so a case that starts a real `claude -p` writes
 * beside the run rather than into the owner's own history. Reading `~/.claude`
 * regardless looked at a machine this run never wrote to, so the case died on a
 * missing directory instead of on anything about the app (bw-t26l.20).
 */
function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * A long answer first so it visibly grows between screenshots, then an edit so a
 * permission card has to appear.
 *
 * Six sentences, not the two this asked for at first: two sentences is about a
 * hundred and fifty characters, which a model can hand over inside one poll, and
 * then the screenshot taken "mid-flight" is of a finished answer and the growth
 * the case is named for never happens. The failure was indistinguishable from
 * streaming being broken, and it was not (bw-t26l.20). Six sentences take long
 * enough that any poll lands in the middle of them.
 */
const PROMPT =
  'In exactly six sentences, say what you are about to do and why, at a leisurely pace. ' +
  'Then append a line saying HELLO to notes.txt using the Edit tool.';

/**
 * A fixture project, made or reused, and marked `isTest` so it stays off the
 * owner's real dashboard and gets swept up by teardown rather than living on
 * his machine like the seven that got left behind before this ran through a
 * script that isolates its own settings DB.
 */
async function projectAt(request: APIRequestContext, path: string, name?: string): Promise<{ id: string }> {
  const existing = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const found = existing.find((p) => p.path === path);
  if (found) return found;
  const created = await request.post('/api/projects', {
    data: { name: name ?? `workbench-${path.split('-').pop()}`, path, isTest: true },
  });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json()) as { id: string };
}

test.describe('workbench', () => {
  /**
   * Every case here drives a REAL provider turn, and the harness copies the
   * bearer credentials into the run only when asked to. Without the flag the
   * `claude` this starts is not signed in, so a case dies three seconds in on
   * an empty transcript directory or a blank answer and says nothing about the
   * app. Say so on the first line instead (bw-t26l.20).
   */
  test.beforeAll(() => {
    expect(process.env.BEADS_E2E_LIVE_PROVIDERS, 'set BEADS_E2E_LIVE_PROVIDERS=1').toBe('1');
  });

  /**
   * `useProject` and the dashboard both resolve a project by filtering the
   * plain project list client-side (`src/hooks/use-project.ts`,
   * `src/hooks/use-projects.ts`) — there is no per-ID lookup on the server. A
   * fixture project is marked `isTest` so a plain `GET /api/projects` leaves it
   * off the owner's real dashboard (bw-6m6w.9), but with nothing else said that
   * same filtering makes it invisible to its OWN browser tab too: the project
   * page never resolves a name and the board never mounts. So every request
   * this page makes for the plain list is asked for test projects as well — a
   * rewrite scoped to this page alone, so a real visitor typing the same URL
   * still sees none of them.
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('live-turn streams an answer and asks permission', async ({ page, request }) => {
    // A real turn: model latency plus a tool round trip. Ten minutes, not five,
    // because the waits inside add up past five on their own — the answer, the
    // growth between two reads of it, and then a permission card for every tool
    // the model reaches for before the Edit one this is really about.
    test.setTimeout(600_000);

    const FIXTURE = fixtureFor('live-turn');
    discardFixture(FIXTURE);
    mkdirSync(FIXTURE, { recursive: true });
    writeFileSync(join(FIXTURE, 'notes.txt'), 'first line\n');
    mkdirSync(SHOTS, { recursive: true });

    const project = await projectAt(request, FIXTURE);

    try {
      await page.goto(`/project?id=${project.id}`);
      await openChatTab(page);

      await page.getByTestId('new-chat').click();
      await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('composer').fill(PROMPT);
      await page.getByTestId('send-button').click();

      // ---- the streamed answer, caught mid-flight -------------------------
      const assistant = page.getByTestId('assistant-message').first();
      await expect(assistant).toBeVisible({ timeout: 90_000 });
      // Wait for real prose rather than the empty bubble the first delta creates.
      await expect.poll(async () => (await assistant.textContent())?.length ?? 0, { timeout: 90_000 }).toBeGreaterThan(20);

      const stop = page.getByTestId('stop-button');
      await expect(stop).toBeVisible();

      const textA = (await assistant.textContent()) ?? '';
      await page.screenshot({ path: join(SHOTS, 'live-turn-a.png'), fullPage: false });

      await expect
        .poll(async () => ((await assistant.textContent()) ?? '').length, { timeout: 60_000 })
        .toBeGreaterThan(textA.length);

      const textB = (await assistant.textContent()) ?? '';
      await page.screenshot({ path: join(SHOTS, 'live-turn-b.png'), fullPage: false });

      expect(textB.length).toBeGreaterThan(textA.length);
      expect(textB.startsWith(textA.slice(0, 20))).toBe(true);
      await expect(stop).toBeVisible();

      // ---- the permission card --------------------------------------------
      // Read-only tools are asked about too, so answer each card until the Edit
      // one arrives; that is the card the screenshots must show. Cards are
      // addressed by their own ask id, never by position — a second card
      // appearing must not shift what the assertions point at.
      //
      // A card is recognised by what ACP puts on it, which is one human
      // sentence for the call — "Edit notes.txt", not "Edit". The name is
      // matched as a word inside that sentence, and the buttons are asked for
      // by their protocol kind rather than by their id or their label: both of
      // those are the agent's own vocabulary, and this agent says "allow-once"
      // and "Yes" where the assertions had guessed "allow_once" and "Allow
      // once" (bw-t26l.20).
      const ALLOW_ONCE = '[data-ask-kind="allow_once"]';
      let editAskId: string | null = null;
      for (let i = 0; i < 8 && editAskId === null; i++) {
        const open = page.locator('[data-testid="permission-card"][data-ask-state="open"]').first();
        await expect(open).toBeVisible({ timeout: 120_000 });
        const askId = await open.getAttribute('data-ask-id');
        const toolName = await open.getAttribute('data-tool-name');
        if (toolName && /\b(Edit|Write|MultiEdit)\b/.test(toolName)) {
          editAskId = askId;
          break;
        }
        await open.locator(ALLOW_ONCE).click();
        await expect(page.locator(`[data-ask-id="${askId}"]`)).toHaveAttribute('data-ask-state', 'resolved', {
          timeout: 60_000,
        });
      }
      expect(editAskId, 'an Edit permission card should appear').not.toBeNull();

      const editCard = page.locator(`[data-ask-id="${editAskId}"]`);
      // Every answer the protocol defines is offered, each carrying a label the
      // agent wrote — whatever that label turns out to say.
      for (const kind of ['allow_once', 'allow_always', 'reject_once']) {
        const button = editCard.locator(`[data-ask-kind="${kind}"]`);
        await expect(button).toBeVisible();
        await expect(button).not.toHaveText('');
      }
      await editCard.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, 'permission-ask.png'), fullPage: false });

      await editCard.locator(ALLOW_ONCE).click();

      await expect(editCard).toHaveAttribute('data-ask-state', 'resolved', { timeout: 60_000 });
      await expect(editCard.getByTestId('permission-resolved')).toHaveText('Allowed');

      // The tool the card guarded must then actually run and finish. The row is
      // named from the adapter's own metadata, where the name is bare.
      const editRow = page.locator('[data-testid="tool-row"][data-tool-name^="Edit"]').last();
      await expect(editRow).toHaveAttribute('data-tool-status', 'ok', { timeout: 120_000 });

      await expect(page.getByTestId('cost-chip')).toBeVisible({ timeout: 180_000 });
      await editRow.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, 'permission-allowed.png'), fullPage: false });
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  /**
   * One finished turn carrying the whole transcript vocabulary at once.
   *
   * Runs with permissions bypassed on purpose: the permission flow is proved by
   * the live-turn test, and cards in between would push the six things being
   * judged off one screen.
   */
  test('transcript shows tools, a diff, a picture, the checklist and a subagent', async ({ page, request }) => {
    test.setTimeout(600_000);

    // A board, because a checklist in this app is a view of an epic and of
    // nothing else: the panel is drawn from that epic's children, read from
    // Beads, and a list the agent keeps for itself is deliberately not drawn
    // (machinery/skills/beads/SKILL.md, "Live checklist"). Asking the agent
    // for its own three items therefore tested a thing the product refuses to
    // do, and the panel it waited for was never coming (bw-t26l.20).
    const RUN_DIR = fixtureFor('transcript');
    const FIXTURE = join(RUN_DIR, 'work');
    discardFixture(RUN_DIR);
    makeFixtureProject(FIXTURE, join(RUN_DIR, 'reporting'), {
      specPath: join(RUN_DIR, 'reporting', 'unused.report.json'),
    });
    // One child left mid-flight, so the panel has a ticked row and a running
    // one to draw at the same moment.
    bd(['update', 'wl-kid2', '--status', 'in_progress'], FIXTURE);
    writeFileSync(join(FIXTURE, 'notes.txt'), 'alpha\nbeta\ngamma\n');
    writeFileSync(join(FIXTURE, 'wheels.md'), '# Wheels\nThey are round.\n');
    writeFileSync(join(FIXTURE, 'brakes.md'), '# Brakes\nThey are hot.\n');
    mkdirSync(SHOTS, { recursive: true });
    // Deliberately outside the project the agent is working in. Left inside it,
    // an agent that never received the attachment can still open the file off
    // disk and answer about it — which is exactly what happened, and is how a
    // prompt that dropped every attached picture on the floor went unnoticed:
    // the picture was drawn in the person's own bubble, so it looked delivered,
    // and the agent's answer about it was right for the wrong reason
    // (bw-t26l.20). Out here, the answer can only come from the attachment.
    // In the run's own scratch folder rather than beside the pictures a run
    // commits as evidence: this one is scaffolding the test draws for itself,
    // and evidence is what a reader is meant to find in there.
    const scratch = join(__dirname, '..', '.artifacts');
    mkdirSync(scratch, { recursive: true });
    const picture = join(scratch, 'attached-quadrants.png');
    writeFileSync(picture, quadrantPng(120));

    const project = await projectAt(request, FIXTURE);

    try {
      const started = await request.post('/api/workbench/command', {
        data: {
          type: 'session.start',
          projectId: project.id,
          projectPath: FIXTURE,
          brand: 'claude',
          permissionMode: 'bypassPermissions',
        },
      });
      expect(started.status(), await started.text()).toBe(200);
      const session = (await started.json()) as { id: string };

      await page.goto(`/project?id=${project.id}&chat=${session.id}`);
      await openChatTab(page);
      await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('image-input').setInputFiles(picture);
      await expect(page.getByTestId('attachment-tray')).toBeVisible();

      await page.getByTestId('composer').fill(
        [
          'Do all of this in one go, using the tools named:',
          // The checklist tool is asked for by what it does, not by one name:
          // the adapter turns both TodoWrite and TaskCreate/TaskUpdate into the
          // ACP `plan` update the panel is drawn from, and which of the two an
          // agent has depends on its model. The tools exist at all only because
          // the adapter is launched with the provider's own switch for them,
          // which it was not: the provider withholds them from every current
          // model, so the agent said it had "no task/checklist tool at all" and
          // no plan update ever reached the app (bw-t26l.20; acp/adapter.rs).
          //
          // What it publishes is the epic's id, alone. Atelier replaces that
          // one row with the epic's children and reads their titles and
          // statuses from the board, so a list the agent writes itself is not
          // a checklist and is not drawn.
          `1. Using your checklist tool (TodoWrite, or TaskCreate if that is what you have), publish a checklist`,
          `   whose single item is exactly "${PARENT_CARD}" — the id of this project's epic, and nothing else.`,
          '2. Read notes.txt.',
          '3. Use the Task tool to launch a general-purpose subagent that reads wheels.md and brakes.md',
          '   and reports what they say.',
          '4. Use Edit on notes.txt to change the line "beta" to "BETA" and add a line "HELLO" after "gamma".',
          '   Do not touch the board: no bd commands, and no further checklist changes.',
          '5. Finish by saying, in one sentence, what colours the attached picture has.',
        ].join('\n'),
      );
      await page.getByTestId('send-button').click();

      // The turn is over when the agent reports its cost.
      await expect(page.getByTestId('cost-chip')).toBeVisible({ timeout: 480_000 });

      // 1. tool rows
      await expect(page.getByTestId('tool-row').first()).toBeVisible();
      // 2. a side-by-side diff with a line marked as changed
      const diff = page.getByTestId('diff-view').first();
      await expect(diff).toBeVisible();
      await expect(diff.locator('[data-diff-kind="changed"], [data-diff-kind="added"]').first()).toBeVisible();
      // 3. the picture, in the user's own bubble — and in the agent's hands
      await expect(page.getByTestId('user-message').getByTestId('message-image').first()).toBeVisible();
      // The four quadrants are red, blue, green and yellow, and the file is not
      // in the project, so nothing but the attachment itself can have told it.
      // Polled, and across every bubble: the cost chip is reported as soon as
      // the agent has spent something, not when it has finished, so a turn
      // whose subagent is still out gets one bubble saying so and the colours
      // in a later one.
      const COLOURS = ['red', 'blue', 'green', 'yellow'];
      const spoken = async () =>
        (await page.getByTestId('assistant-message').allTextContents()).join(' ').toLowerCase();
      await expect
        .poll(async () => {
          const said = await spoken();
          return COLOURS.filter((colour) => said.includes(colour));
        }, {
          timeout: 240_000,
          message: 'the agent should have seen the attached picture',
        })
        .toEqual(COLOURS);
      // 4. the checklist: the epic's own children, with one ticked and one
      //    running, and their titles taken from the board rather than from
      //    anything the agent wrote.
      await expect(page.getByTestId('todo-panel')).toBeVisible({ timeout: 30_000 });
      // `toContainText`, because the ticked row draws its own tick before the
      // title.
      await expect(page.locator('[data-testid="todo-item"][data-todo-status="completed"]')).toContainText([
        'First piece of the work',
      ]);
      await expect(page.locator('[data-testid="todo-item"][data-todo-status="in_progress"]')).toContainText([
        'Second piece of the work',
      ]);
      // 5. the subagent: a row on the rail, and — opened — the reading it
      //    actually did. Not a row in this transcript: work the chat sent away
      //    is deliberately kept out of it (`sentAway` in
      //    src/workbench/message-filter.ts, bw-qdim.12), and the reader who
      //    wants the helper's side clicks through to it.
      const helper = page.locator('[data-testid="sent-away-row"][data-kind="helper"]').first();
      await expect(page.getByTestId('sent-away-panel')).toHaveAttribute('data-rows', /[1-9]/, {
        timeout: 60_000,
      });
      // Folded away, because by now it has finished: the panel keeps what is
      // over behind its own control so the running work stays at the top of the
      // rail (src/workbench/sent-away.tsx).
      const folded = page.getByTestId('toggle-stopped-agents');
      if (await folded.isVisible()) await folded.click();
      await expect(helper).toBeVisible({ timeout: 60_000 });
      // The card says what it reported, not just that it is over.
      await expect(helper.getByTestId('sent-away-result')).toContainText(/wheels|brakes|round|hot/i);

      // The helper's pane first, on the window this run was given, and the tall
      // picture of the whole conversation after it. The other way round the
      // panel's picture is a lie: a capture taller than the browser's own
      // window paints `position: fixed` layers over only the first window's
      // worth of it and leaves the rest unlayered, and the emulation stays
      // wrong after the window is put back — so an open panel photographed
      // either at 2400 or at 900 after 2400 showed the conversation underneath
      // drawn straight through it, undimmed, with nothing wrong with the panel.
      // Measured 2026-09-03 on a static page with no app code in it at all: the
      // same `fixed inset-0` dim covers the top of a 2400-tall capture and
      // stops partway down, whether the viewport was resized to 2400 or born
      // there.

      // Opened, the helper's own conversation has the two files it was sent to
      // read. This is the join the app has to get right: the helper's rows
      // arrive on the parent session stamped with the CALL that spawned it,
      // while its card carries an agent id, and a pane matched on the wrong one
      // opens empty (bw-t26l.20).
      await helper.getByTestId('sent-away-open').click();
      const said = page.getByTestId('agent-view-said');
      await expect(said).toBeVisible();
      await expect
        .poll(async () => (await said.innerText()).toLowerCase(), {
          timeout: 60_000,
          message: "the helper's own pane should show the reading it did",
        })
        .toMatch(/wheels\.md[\s\S]*brakes\.md|brakes\.md[\s\S]*wheels\.md/);
      // `subagent-tool-row`, which is what a row whose parent was sent away is
      // marked as wherever it is drawn (transcript-rows.tsx). Two of them: one
      // read per file it was sent to read.
      const read = said.getByTestId('subagent-tool-row');
      await expect(read).toHaveCount(2, { timeout: 30_000 });
      await expect(read.first()).toBeVisible();
      // Settled before it is photographed. The panel and the dim behind it
      // both fade in over 200ms (`data-[state=open]:fade-in-0` in
      // src/components/ui/dialog.tsx) and `page.screenshot` does not wait for
      // an animation, so a picture taken the moment the rows appear catches
      // both half-drawn — the conversation underneath showing straight through
      // the panel, undimmed. Waiting for the two of them to reach full opacity
      // is also the assertion that the panel is opaque and does dim what it
      // covers, which is how a reader can tell what they are looking at.
      const dim = page.locator('[class*="bg-black/50"]');
      await expect(dim).toBeVisible();
      await expect(dim).toHaveCSS('opacity', '1');
      await expect(page.getByTestId('agent-view')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: join(SHOTS, 'transcript-helper.png'), fullPage: false });

      // Shut, and then a tall window so one picture carries all six of the
      // things above rather than a scrolled slice of them.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('agent-view')).toBeHidden();
      await page.setViewportSize({ width: 1440, height: 2400 });
      await page.getByTestId('transcript').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.screenshot({ path: join(SHOTS, 'transcript.png'), fullPage: false });
      // 6. cost, already asserted above
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  /**
   * The interconnection: chat to card, and the card back to the chat. Runs
   * against a throwaway board the fixture builds — never a live one — with
   * permissions bypassed so the screens stay uncluttered.
   *
   * A third part used to sit between those two, asking for the report the chat
   * had just written: drawn in the stream, opened in its own tab, and still
   * there after a Back. The owner retired reports outright in 384beb2 — the
   * tab, the routes, the builder and the blocks all went — and this kept
   * asking for `report-inline` regardless, so a live run spent a minute
   * waiting on an element deliberately deleted and failed on it every time
   * (bw-t26l.20). What is left is the join, which is what the case is for.
   */
  test('links a chat to the card it touched and carries row chips both ways', async ({ page, request }) => {
    test.setTimeout(600_000);

    const RUN_DIR = fixtureFor('links');
    const FIXTURE = join(RUN_DIR, 'linked');
    discardFixture(RUN_DIR);
    makeFixtureProject(FIXTURE, join(RUN_DIR, 'reporting'));
    mkdirSync(SHOTS, { recursive: true });

    const project = await projectAt(request, FIXTURE, 'workbench-links');

    try {
      const started = await request.post('/api/workbench/command', {
        data: {
          type: 'session.start',
          projectId: project.id,
          projectPath: FIXTURE,
          brand: 'claude',
          permissionMode: 'bypassPermissions',
        },
      });
      expect(started.status(), await started.text()).toBe(200);
      const session = (await started.json()) as { id: string };

      await page.goto(`/project?id=${project.id}&chat=${session.id}`);
      await openChatTab(page);
      await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 30_000 });

      // Nothing here names the card to the app: the agent is told to run a bd
      // command, and the app has to notice that by itself.
      await page.getByTestId('composer').fill(
        [
          `Run this exact shell command and show me its output: bd note ${PARENT_CARD} "looked at by the workbench"`,
          '',
          'Do nothing else.',
        ].join('\n'),
      );
      await page.getByTestId('send-button').click();

      // ---- (a) the chip nobody typed --------------------------------------
      const chip = page.locator(`[data-testid="bead-chip"][data-bead-id="${PARENT_CARD}"]`);
      await expect(chip).toBeVisible({ timeout: 300_000 });
      await expect(page.getByTestId('cost-chip')).toBeVisible({ timeout: 300_000 });
      await page.screenshot({ path: join(SHOTS, 'link-a.png'), fullPage: false });

      // The board is the record, so the edge must be readable straight from bd.
      const onBoard = await request.get(
        `/api/workbench/links/bead/${PARENT_CARD}?path=${encodeURIComponent(FIXTURE)}`,
      );
      expect(onBoard.status()).toBe(200);
      const chats = (await onBoard.json()) as { sessionId: string }[];
      expect(chats.map((c) => c.sessionId)).toContain(session.id);

      // ---- (b) the card's own side of the join ----------------------------
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`/project?id=${project.id}`);
      await page.getByTestId('tab-board').click();
      await page.getByText('The card this chat works on').first().click();

      const chatList = page.getByTestId('card-chats');
      await expect(chatList).toBeVisible({ timeout: 60_000 });
      const entry = chatList.locator(`[data-session-id="${session.id}"]`);
      await expect(entry).toBeVisible();
      await page.screenshot({ path: join(SHOTS, 'link-b.png'), fullPage: false });

      // Clicking it lands back on that very chat.
      await entry.click();
      await expect(page.getByTestId('chat-tab')).toHaveAttribute('data-session-id', session.id, {
        timeout: 60_000,
      });
      await expect(
        page.locator(`[data-testid="bead-chip"][data-bead-id="${PARENT_CARD}"]`),
      ).toBeVisible({ timeout: 60_000 });

      // ---- and the chat list says the same thing, one line per chat -------
      // The row knows which cards the chat worked on — it carries them rather than
      // drawing them, so the rail stays two lines of words.
      const row = page.locator(`[data-testid="restore-row"][data-row-key="${session.id}"]`);
      await expect(row).toHaveAttribute('data-beads', new RegExp(`\\b${PARENT_CARD}\\b`), { timeout: 60_000 });
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  /**
   * Yesterday's sessions, back after a real restart.
   *
   * The terminal session is a genuine one: `claude -p` is run outside the app,
   * and the app finds it the only way it is allowed to — by listing the
   * transcript directory. Its file is then dated a day back, which is the same
   * thing that would be true had it been run yesterday.
   */
  test('restore lists yesterday under each row name, and brings a terminal session back', async ({ page, request }) => {
    test.setTimeout(900_000);

    const FIXTURE = fixtureFor('restore');
    discardFixture(FIXTURE);
    mkdirSync(FIXTURE, { recursive: true });
    writeFileSync(join(FIXTURE, 'notes.txt'), 'a line\n');
    mkdirSync(SHOTS, { recursive: true });

    // A real session, started outside the app.
    execFileSync('claude', ['-p', 'Reply with exactly: READY', '--permission-mode', 'bypassPermissions'], {
      cwd: FIXTURE,
      timeout: 240_000,
      stdio: 'pipe',
    });

    const slug = FIXTURE.replace(/[^A-Za-z0-9]/g, '-');
    const slugDir = join(claudeHome(), 'projects', slug);
    // The newest, not the first the directory happens to name: earlier runs
    // leave their transcripts here, and resuming one of those would be testing
    // last week's conversation.
    const transcripts = readdirSync(slugDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, at: statSync(join(slugDir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    expect(transcripts.length, 'the terminal session left a transcript').toBeGreaterThan(0);
    const newest = transcripts[0]!.f;
    const terminalId = newest.replace(/\.jsonl$/, '');
    // Dated a day back so it groups under Yesterday. The file is never opened.
    const yesterday = new Date(Date.now() - 86_400_000);
    const ownName = readFileSync(join(slugDir, newest), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; aiTitle?: string })
      .find((row) => row.type === 'ai-title')?.aiTitle;
    expect(ownName, 'the terminal session named itself').toBeTruthy();
    utimesSync(join(slugDir, newest), yesterday, yesterday);

    const project = await projectAt(request, FIXTURE);

    try {
      // A chat of the app's own, so the list has both kinds in it.
      const started = await request.post('/api/workbench/command', {
        data: {
          type: 'session.start',
          projectId: project.id,
          projectPath: FIXTURE,
          brand: 'claude',
          permissionMode: 'bypassPermissions',
        },
      });
      const mine = (await started.json()) as { id: string };
      await request.post('/api/workbench/command', {
        data: { type: 'prompt.send', sessionId: mine.id, text: 'Reply with exactly: FIRST' },
      });
      // Not merely titled: waited on until the agent has said who it is. A chat
      // killed before that has no conversation to come back to, and "yesterday's
      // sessions" means ones that really happened.
      await expect
        .poll(
          async () => {
            const rows = (await (await request.get(`/api/workbench/restore?project=${project.id}&path=${encodeURIComponent(FIXTURE)}`)).json()) as {
              sessionId: string | null;
              externalId: string | null;
              title: string | null;
            }[];
            const row = rows.find((r) => r.sessionId === mine.id);
            return Boolean(row?.title && row.externalId);
          },
          { timeout: 300_000 },
        )
        .toBe(true);

      // ---- the restart the whole item is about ----------------------------
      await restartInstance({
        binary: join(__dirname, '..', '..', 'server', 'target', 'debug', 'atelier'),
        serverPort: Number(process.env.BEADS_WEB_PORT ?? 3018),
        sidecarPort: Number(process.env.BEADS_WORKBENCH_PORT ?? 3019),
        env: process.env,
        healthUrl: `${process.env.BEADS_E2E_URL}/api/workbench/health`,
        logFile: join(process.env.WORKBENCH_E2E_RUN ?? join(__dirname, '..', '.e2e-run'), 'server.log'),
      });

      await page.goto(`/project?id=${project.id}&tab=chat`);
      await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: 60_000 });

      // Both kinds are listed, and the day headings are real.
      // By the conversation's own id, not by the row key: taking a terminal
      // session over gives it one of our session ids, and it is still the row
      // the owner clicked.
      const terminalRow = page.locator(`[data-testid="restore-row"][data-external-id="${terminalId}"]`);
      await expect(terminalRow).toBeVisible({ timeout: 60_000 });
      await expect(terminalRow).toHaveAttribute('data-origin', 'terminal');
      await expect(page.getByTestId('day-heading').filter({ hasText: 'Yesterday' })).toBeVisible();
      await expect(page.locator('[data-testid="restore-row"][data-origin="app"]').first()).toBeVisible();
      // Nothing woke itself up over the restart.
      await expect(terminalRow).toHaveAttribute('data-state', 'dormant');

      // The row says what the conversation calls itself. Claude names its own
      // conversations and writes that name into the record; the list shows it
      // exactly as written, whatever it says — only a chat that never named
      // itself gets a name of ours, cut down from what was asked. Read from
      // this run's own record rather than hard-coded: the name is Claude's to
      // choose, and it has chosen differently for the same prompt.
      await expect(terminalRow.getByTestId('row-name')).toHaveText(ownName);
      // And where it ran, by the folder's own name — carried on the row rather
      // than drawn on it: the rail is two lines wide now and the chat's own bar
      // names the folder and its branch the moment the row is clicked.
      await expect(terminalRow).toHaveAttribute('data-folder', basename(FIXTURE));
      await page.screenshot({ path: join(SHOTS, 'restore.png'), fullPage: false });

      // ---- one click brings the terminal session back ---------------------
      // The click is on the row's own name. There is no Resume button any more:
      // b3cbddd took it out, on the rule that a list of chats opens a chat when
      // you click it, and `chat-list.spec.ts` holds the app to that. This case
      // kept clicking the button that commit deleted (bw-t26l.20).
      await terminalRow.getByTestId('row-name').click();
      await expect(page.getByTestId('restore-error')).toHaveCount(0);
      // Opening is read-only, on purpose: no agent is started and the row
      // stays asleep until something is said in it (provider.rs, the
      // SessionOpen arm — "the first prompt is what wakes (or resumes) its
      // provider"). So the click is proved by the conversation appearing, not
      // by a pill: the words the terminal session said yesterday are on
      // screen, which is what makes this the same chat and not a new one.
      // This case asked instead for a pill that only exists while a chat is
      // busy, and later for a state the app deliberately does not enter on a
      // click, and spent three minutes each time waiting for neither
      // (bw-t26l.20).
      await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('assistant-message').first()).toContainText('READY', {
        timeout: 180_000,
      });

      await page.getByTestId('composer').fill('Reply with exactly: RESUMED');
      await page.getByTestId('send-button').click();
      const answer = page.getByTestId('assistant-message').last();
      await expect(answer).toContainText('RESUMED', { timeout: 300_000 });
      // And now it is awake — the prompt is what woke it, and the rail says so
      // on the row that was clicked.
      await expect(terminalRow).not.toHaveAttribute('data-state', 'dormant', { timeout: 60_000 });
      await page.screenshot({ path: join(SHOTS, 'restore-resumed.png'), fullPage: false });

      // ---- and the app's own chat is placed the same way ------------------
      const appRow = page.locator('[data-testid="restore-row"][data-origin="app"]').first();
      await expect(appRow).toHaveAttribute('data-folder', basename(FIXTURE));
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  /**
   * The tray, across projects.
   *
   * Two projects with a real turn running in each, seen from the project list —
   * a screen belonging to neither of them, which is the whole point: what is
   * waiting on the owner follows him everywhere rather than living inside one
   * chat.
   *
   * The running half of that pair used to be here too: a `glance-strip` beside
   * the tray, naming every chat working right now. The owner took it out of the
   * bar in 055a5c8, leaving the tray alone there, and this case kept asking for
   * it — so a live run failed for two minutes on an element deliberately
   * deleted, which says nothing about the app and hid the failures underneath
   * it (bw-t26l.20). What follows him is now only the tray, and that is all
   * this asks about.
   */
  test('tray counts what waits on you across projects', async ({ page, request }) => {
    test.setTimeout(600_000);
    mkdirSync(SHOTS, { recursive: true });

    const started: { id: string; projectId: string }[] = [];
    // Tracked apart from `started`, which is keyed on the chat session and
    // read all through the test — this is only for the cleanup at the end.
    const projectIds: string[] = [];
    try {
      for (const name of ['tray-a', 'tray-b']) {
        const dir = fixtureFor(name);
        discardFixture(dir);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'notes.txt'), 'first line\n');
        const project = await projectAt(request, dir);
        projectIds.push(project.id);
        // Permission mode 'default' on purpose: the edit in PROMPT then has to
        // ask, which is what the tray is a list of.
        const res = await request.post('/api/workbench/command', {
          data: { type: 'session.start', projectId: project.id, projectPath: dir, brand: 'claude' },
        });
        const session = (await res.json()) as { id: string };
        started.push({ id: session.id, projectId: project.id });
        await request.post('/api/workbench/command', {
          data: { type: 'prompt.send', sessionId: session.id, text: PROMPT },
        });
      }

      // The project list — neither project's own screen.
      await page.goto('/');

      // Both turns reach their edit and stop for permission: the badge reads two.
      const badge = page.getByTestId('tray-badge');
      await expect(badge).toHaveAttribute('data-count', '2', { timeout: 300_000 });

      await badge.click();
      const rows = page.getByTestId('tray-row');
      await expect(rows).toHaveCount(2);
      for (const s of started) {
        const row = page.locator(`[data-testid="tray-row"][data-session-id="${s.id}"]`);
        await expect(row.getByTestId('tray-project')).not.toBeEmpty();
        await expect(row.getByTestId('tray-waiting-for')).toContainText(/\S/);
      }
      await page.screenshot({ path: join(SHOTS, 'tray.png'), fullPage: false });

      // A row lands on its own chat, with the ask on screen.
      await page.locator(`[data-testid="tray-row"][data-session-id="${started[0]!.id}"]`).click();
      await expect(page.getByTestId('chat-tab')).toHaveAttribute('data-session-id', started[0]!.id, {
        timeout: 60_000,
      });
      await expect(page.locator('[data-testid="permission-card"][data-ask-state="open"]').first()).toBeVisible({
        timeout: 60_000,
      });
      await page.screenshot({ path: join(SHOTS, 'tray-landed.png'), fullPage: false });
    } finally {
      for (const id of projectIds) {
        await request.delete(`/api/projects/${id}`);
      }
    }
  });

  /**
   * From the card, on the board, and on a phone.
   *
   * One chat serves all three: started from a card so it opens already knowing
   * what the card says, which puts a live line on that card back on the board,
   * and read once more at phone size.
   */
  test('from-card briefs the chat, marks the board, and reads on a phone', async ({ page, request }) => {
    test.setTimeout(600_000);

    const FIXTURE = fixtureFor('from-card');
    const REPORTS = join(__dirname, '..', '.workbench-run-from-card-reports');
    discardFixture(REPORTS);
    makeFixtureProject(FIXTURE, REPORTS);
    mkdirSync(SHOTS, { recursive: true });

    const project = await projectAt(request, FIXTURE);
    try {
      await page.goto(`/project?id=${project.id}`);

      // Open the card, and start a chat from it.
      await page.locator(`[data-bead-id="${PARENT_CARD}"]`).first().click();
      const start = page.getByTestId('start-chat-from-card');
      await expect(start).toBeVisible({ timeout: 60_000 });
      await start.click();

      // It lands on a chat that already quotes the card, with its chip in the header.
      const tab = page.getByTestId('chat-tab');
      await expect(tab).toBeVisible({ timeout: 120_000 });
      const opened = await tab.getAttribute('data-session-id');
      expect(opened, 'the button opened a chat').toBeTruthy();
      await expect(page.getByTestId('user-message').first()).toContainText('The card this chat works on', {
        timeout: 60_000,
      });
      await expect(page.locator(`[data-testid="bead-chip"][data-bead-id="${PARENT_CARD}"]`)).toBeVisible({
        timeout: 60_000,
      });
      await page.screenshot({ path: join(SHOTS, 'from-card.png'), fullPage: false });

      // Back on the board, that card is the one showing a live line.
      await page.getByTestId('tab-board').click();
      const liveLine = page.locator(`[data-testid="card-live-chat"][data-bead-id="${PARENT_CARD}"]`);
      await expect(liveLine).toBeVisible({ timeout: 120_000 });
      await expect(liveLine).toHaveAttribute('data-session-id', opened!);
      await expect(page.getByTestId('card-live-chat')).toHaveCount(1);
      await page.screenshot({ path: join(SHOTS, 'board-dot.png'), fullPage: false });

      // And the same chat on a phone: the list is a drawer, the composer is in reach.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${opened}`);
      await expect(page.getByTestId('composer')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('chat-rail')).toHaveAttribute('data-open', 'false');

      const composer = await page.getByTestId('composer').boundingBox();
      expect(composer, 'the composer is on screen').toBeTruthy();
      expect(composer!.y + composer!.height, 'the composer is within the screen').toBeLessThanOrEqual(844);

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflows, 'nothing pushes the page sideways').toBe(false);
      await page.screenshot({ path: join(SHOTS, 'phone.png'), fullPage: false });

      // The drawer opens over the conversation rather than beside it.
      await page.getByTestId('chat-rail-toggle').click();
      await expect(page.getByTestId('chat-rail')).toHaveAttribute('data-open', 'true');
      await page.screenshot({ path: join(SHOTS, 'phone-drawer.png'), fullPage: false });
    } finally {
      await request.delete(`/api/projects/${project.id}`);
    }
  });

  /**
   * Everything ever said.
   *
   * Two chats in two projects, each told a word of its own, so a search has to
   * reach across both and a matched sentence has to name which chat it came
   * from. What the turns cost is still what says both of them finished.
   *
   * The half of this case that opened the what-it-cost screen went with the
   * button, and with the screen behind it (bw-81wt.13).
   */
  test('search finds words across chats', async ({ page, request }) => {
    test.setTimeout(600_000);
    mkdirSync(SHOTS, { recursive: true });

    const WORD = 'PERIWINKLE';
    const started: { id: string; projectId: string; name: string }[] = [];
    // Tracked apart from `started`, which is keyed on the chat session and
    // read all through the test — this is only for the cleanup at the end.
    const projectIds: string[] = [];
    try {
      for (const name of ['spend-a', 'spend-b']) {
        const dir = fixtureFor(name);
        discardFixture(dir);
        mkdirSync(dir, { recursive: true });
        const project = await projectAt(request, dir);
        projectIds.push(project.id);
        const res = await request.post('/api/workbench/command', {
          data: {
            type: 'session.start',
            projectId: project.id,
            projectPath: dir,
            brand: 'claude',
            permissionMode: 'bypassPermissions',
          },
        });
        const session = (await res.json()) as { id: string };
        started.push({ id: session.id, projectId: project.id, name });
        await request.post('/api/workbench/command', {
          data: {
            type: 'prompt.send',
            sessionId: session.id,
            text: `Reply with exactly this sentence and nothing else: The word is ${WORD} in ${name}.`,
          },
        });
      }

      // Both turns have to finish: the cost only arrives when the turn is
      // done. In tokens, not in dollars — this asked for `usd > 0`, and
      // Claude reports no price at all, so the answer was 0 for five minutes
      // every time. A subscription has no per-turn dollar figure to give;
      // ACP carries one only from a provider that bills by the call
      // (normalize.rs, the `usd` cost update) (bw-t26l.20).
      await expect
        .poll(
          async () => {
            const rows = (await (await request.get('/api/workbench/spend')).json()) as {
              projectId: string;
              tokens: number;
            }[];
            return rows.filter((r) => r.tokens > 0 && projectIds.includes(r.projectId)).length;
          },
          { timeout: 300_000 },
        )
        .toBeGreaterThanOrEqual(2);

      // The way in lives at the top of the chat list (docs/designs/app-shell.md §1.1).
      await page.goto(`/project?id=${started[0].projectId}&tab=chat`);
      await page.getByTestId('open-search').click();
      await page.getByTestId('search-input').fill(WORD);

      // Matches from two different chats, each with the word marked.
      await expect.poll(async () => page.getByTestId('search-hit').count(), { timeout: 60_000 })
        .toBeGreaterThanOrEqual(2);
      const ids = await page.getByTestId('search-hit').evaluateAll(
        (nodes) => nodes.map((n) => n.getAttribute('data-session-id')),
      );
      expect(new Set(ids).size, 'the matches come from more than one chat').toBeGreaterThanOrEqual(2);
      await expect(page.getByTestId('search-mark').first()).toHaveText(WORD);
      await expect(page.getByTestId('search-project').first()).not.toBeEmpty();
      await page.screenshot({ path: join(SHOTS, 'search.png'), fullPage: false });

      // A hit lands on the chat that said it.
      await page.getByTestId('search-hit').first().click();
      await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 60_000 });
    } finally {
      for (const id of projectIds) {
        await request.delete(`/api/projects/${id}`);
      }
    }
  });
});