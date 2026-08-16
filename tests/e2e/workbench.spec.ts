import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { makeFixtureProject, PARENT_CARD, REPORT_SLUG } from './fixture-board';
import { restartInstance } from './restart';
import { quadrantPng } from './fixture-png';

/**
 * Agent workbench end-to-end. Design: docs/agent-workbench.md.
 *
 * Drives a REAL Claude session through the app, so it needs:
 *   - a beads-server built from this worktree, with the workbench sidecar,
 *     reachable at BEADS_E2E_URL (default http://localhost:3008);
 *   - the terminal's own Claude sign-in. No API key is set or read.
 *
 * Run: BEADS_E2E_URL=http://127.0.0.1:3018 npx playwright test tests/e2e/workbench.spec.ts -g live-turn
 */

/**
 * One directory per test, kept out of Playwright's outputDir (which is wiped at
 * the start of a run). Separate because the tests run in parallel and each one
 * clears its own fixture — a shared directory would have them racing.
 */
const fixtureFor = (name: string) => join(__dirname, '..', `.workbench-run-${name}`);
const SHOTS = join(__dirname, '..', 'results');

/**
 * Two sentences first so the answer visibly grows between screenshots, then an
 * edit so a permission card has to appear.
 */
const PROMPT =
  'In exactly two sentences, say what you are about to do. ' +
  'Then append a line saying HELLO to notes.txt using the Edit tool.';

/** Reuses the project row a previous run left behind; its path is unique. */
async function projectAt(request: APIRequestContext, path: string): Promise<{ id: string }> {
  const existing = (await (await request.get('/api/projects')).json()) as { id: string; path: string }[];
  const found = existing.find((p) => p.path === path);
  if (found) return found;
  const created = await request.post('/api/projects', { data: { name: `workbench-${path.split('-').pop()}`, path } });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json()) as { id: string };
}

test.describe('workbench', () => {
  test('live-turn streams an answer and asks permission', async ({ page, request }) => {
    // A real turn: model latency plus a tool round trip.
    test.setTimeout(300_000);

    const FIXTURE = fixtureFor('live-turn');
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
    writeFileSync(join(FIXTURE, 'notes.txt'), 'first line\n');
    mkdirSync(SHOTS, { recursive: true });

    const project = await projectAt(request, FIXTURE);

    await page.goto(`/project?id=${project.id}`);
    await page.getByTestId('tab-chat').click();

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
    let editAskId: string | null = null;
    for (let i = 0; i < 8 && editAskId === null; i++) {
      const open = page.locator('[data-testid="permission-card"][data-ask-state="open"]').first();
      await expect(open).toBeVisible({ timeout: 120_000 });
      const askId = await open.getAttribute('data-ask-id');
      const toolName = await open.getAttribute('data-tool-name');
      if (toolName && /^(Edit|Write|MultiEdit)$/.test(toolName)) {
        editAskId = askId;
        break;
      }
      await open.getByTestId('permission-allow_once').click();
      await expect(page.locator(`[data-ask-id="${askId}"]`)).toHaveAttribute('data-ask-state', 'resolved', {
        timeout: 60_000,
      });
    }
    expect(editAskId, 'an Edit permission card should appear').not.toBeNull();

    const editCard = page.locator(`[data-ask-id="${editAskId}"]`);
    await expect(editCard.getByTestId('permission-allow_once')).toHaveText('Allow once');
    await expect(editCard.getByTestId('permission-allow_always')).toHaveText('Allow always');
    await expect(editCard.getByTestId('permission-deny')).toHaveText('Deny');
    await editCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, 'permission-ask.png'), fullPage: false });

    await editCard.getByTestId('permission-allow_once').click();

    await expect(editCard).toHaveAttribute('data-ask-state', 'resolved', { timeout: 60_000 });
    await expect(editCard.getByTestId('permission-resolved')).toHaveText('Allowed');

    // The tool the card guarded must then actually run and finish.
    const editRow = page.locator('[data-testid="tool-row"][data-tool-name="Edit"]').last();
    await expect(editRow).toHaveAttribute('data-tool-status', 'ok', { timeout: 120_000 });

    await expect(page.getByTestId('cost-chip')).toBeVisible({ timeout: 180_000 });
    await editRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, 'permission-allowed.png'), fullPage: false });
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

    const FIXTURE = fixtureFor('transcript');
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
    writeFileSync(join(FIXTURE, 'notes.txt'), 'alpha\nbeta\ngamma\n');
    writeFileSync(join(FIXTURE, 'wheels.md'), '# Wheels\nThey are round.\n');
    writeFileSync(join(FIXTURE, 'brakes.md'), '# Brakes\nThey are hot.\n');
    mkdirSync(SHOTS, { recursive: true });
    const picture = join(FIXTURE, 'picture.png');
    writeFileSync(picture, quadrantPng(120));

    const project = await projectAt(request, FIXTURE);

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
    await page.getByTestId('tab-chat').click();
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('image-input').setInputFiles(picture);
    await expect(page.getByTestId('attachment-tray')).toBeVisible();

    await page.getByTestId('composer').fill(
      [
        'Do all of this in one go, using the tools named:',
        '1. With TaskCreate, add three checklist items: "Read the notes", "Ask a helper about the docs", "Append HELLO".',
        '2. TaskUpdate the first to in_progress, Read notes.txt, then TaskUpdate it to completed.',
        '3. TaskUpdate the second to in_progress, then use the Task tool to launch a general-purpose subagent',
        '   that reads wheels.md and brakes.md and reports what they say. Then TaskUpdate the second to completed.',
        '4. TaskUpdate the third to in_progress, then use Edit on notes.txt to change the line "beta" to "BETA" and',
        '   add a line "HELLO" after "gamma". Leave the third item in_progress — do NOT complete it.',
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
    // 3. the picture, in the user's own bubble
    await expect(page.getByTestId('user-message').getByTestId('message-image').first()).toBeVisible();
    // 4. the checklist, with one ticked and one running
    await expect(page.getByTestId('todo-panel')).toBeVisible();
    await expect(page.locator('[data-testid="todo-item"][data-todo-status="completed"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="todo-item"][data-todo-status="in_progress"]').first()).toBeVisible();
    // 5. a subagent's own call, indented under the call that spawned it
    await expect(page.getByTestId('subagent-tool-row').first()).toBeVisible();
    // 6. cost, already asserted above

    // A tall window so one screenshot carries all six rather than a scrolled slice.
    await page.setViewportSize({ width: 1440, height: 2400 });
    await page.getByTestId('transcript').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.screenshot({ path: join(SHOTS, 'transcript.png'), fullPage: false });
  });

  /**
   * The interconnection: chat to card, card back to chat, and a report that
   * opens large. Runs against a throwaway board the fixture builds — never a
   * live one — with permissions bypassed so the screens stay uncluttered.
   */
  test('links a chat to the card it touched, and shows the report it made', async ({ page, request }) => {
    test.setTimeout(600_000);

    const FIXTURE = fixtureFor('links');
    const reportsDir = join(FIXTURE, 'reporting');
    makeFixtureProject(FIXTURE, reportsDir);
    mkdirSync(SHOTS, { recursive: true });

    const project = await projectAt(request, FIXTURE);

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
    await page.getByTestId('tab-chat').click();
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 30_000 });

    // Nothing here names the card to the app: the agent is told to run a bd
    // command, and the app has to notice that by itself.
    await page.getByTestId('composer').fill(
      [
        `Run this exact shell command and show me its output: bd note ${PARENT_CARD} "looked at by the workbench"`,
        '',
        `Then use the Edit tool on reporting/pages/linkdemo/${REPORT_SLUG}.report.json to change its`,
        '"eyebrow" line to say: Written from the chat that made it.',
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

    // ---- (c) the report, inline then large ------------------------------
    const inline = page.getByTestId('report-inline');
    await expect(inline).toBeVisible({ timeout: 60_000 });
    await inline.scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.screenshot({ path: join(SHOTS, 'link-c-inline.png'), fullPage: false });

    await inline.click();
    const modal = page.getByTestId('report-modal');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    // The page inside really is the built report, not an error.
    const framed = page.frameLocator('[data-testid="report-modal-frame"]');
    await expect(framed.locator('text=Linked From The Chat').first()).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: join(SHOTS, 'link-c.png'), fullPage: false });
    await page.getByTestId('report-modal-close').click();
    await expect(modal).toBeHidden({ timeout: 15_000 });

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
  });

  /**
   * Yesterday's sessions, back after a real restart.
   *
   * The terminal session is a genuine one: `claude -p` is run outside the app,
   * and the app finds it the only way it is allowed to — by listing the
   * transcript directory. Its file is then dated a day back, which is the same
   * thing that would be true had it been run yesterday.
   */
  test('restore lists yesterday and brings a terminal session back', async ({ page, request }) => {
    test.setTimeout(900_000);

    const FIXTURE = fixtureFor('restore');
    rmSync(FIXTURE, { recursive: true, force: true });
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
    const slugDir = join(homedir(), '.claude', 'projects', slug);
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
    utimesSync(join(slugDir, newest), yesterday, yesterday);

    const project = await projectAt(request, FIXTURE);

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
      binary: join(__dirname, '..', '..', 'server', 'target', 'debug', 'beads-server'),
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
    await expect(terminalRow.getByTestId('row-pill')).toHaveText('dormant');
    await page.screenshot({ path: join(SHOTS, 'restore.png'), fullPage: false });

    // ---- one click brings the terminal session back ---------------------
    await terminalRow.getByTestId('resume-row').click();
    await expect(page.getByTestId('restore-error')).toHaveCount(0);
    await expect(terminalRow.getByTestId('row-pill')).toHaveText('ready', { timeout: 180_000 });
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('composer').fill('Reply with exactly: RESUMED');
    await page.getByTestId('send-button').click();
    const answer = page.getByTestId('assistant-message').last();
    await expect(answer).toContainText('RESUMED', { timeout: 300_000 });
    await page.screenshot({ path: join(SHOTS, 'restore-resumed.png'), fullPage: false });

    // ---- and one click brings back the rest -----------------------------
    await page.getByTestId('resume-all').click();
    await expect
      .poll(async () => page.locator('[data-testid="row-pill"][data-pill="dormant"]').count(), { timeout: 300_000 })
      .toBe(0);
    await page.screenshot({ path: join(SHOTS, 'restore-all.png'), fullPage: false });
  });
});