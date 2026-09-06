import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { PARENT_CARD, discardFixture, makeFixtureProject } from './fixture-board';
import { writeChatWithHelper } from './fixture-record';

/**
 * A shell a chat left running, and which the kit has since said is over, is
 * over on the panel too (bw-3cmk.1).
 *
 * The kit never tells a client that a backgrounded command ended. It tells
 * ITSELF: a `<task-notification>` goes into its own prompt queue, and the queue
 * is written into the record as a `queue-operation` row with no uuid. Read back
 * off the disk, those rows were nobody's — the conversation is rebuilt from the
 * rows that carry a uuid — so a chat reopened after its build had finished
 * showed the build still running, eleven hours on.
 *
 * Proved off a written record, because that is the reading a reopened chat
 * gets. Two shells: one the kit has written an ending for, one it has not, so
 * the picture shows the two apart — done with its exit code, against the
 * lost-sight row an asleep chat draws for work nobody reported on.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-finished-shell-is-not-still-running.spec.ts
 */

/** A folder of its own, so this case never reads somebody's real chats. */
const RUN = join(__dirname, '..', '.workbench-run-finished-shell');
const PROJECT = join(RUN, 'project');

/** Opening a chat off the disk still waits on the list arriving. */
const OPEN_MS = 60_000;

/** The shell the kit says is over, and the one it has said nothing about. */
const OVER = 'bfixture001';
const STILL = 'bfixture002';

async function projectAt(request: APIRequestContext, name: string, path: string): Promise<{ id: string }> {
  const made = await request.post('/api/projects', { data: { name, path } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

/**
 * Two commands left running, written after the chat's own turns the way the
 * kit writes them: the call, its answer naming the background task, and — for
 * the first only — the kit's note to itself that the task completed.
 */
function leaveTwoShellsRunning(record: string, sessionId: string, cwd: string, lastUuid: string): void {
  const began = Date.now() - 30 * 60 * 1000;
  const when = (seconds: number): string => new Date(began + seconds * 1000).toISOString();
  const rows: Record<string, unknown>[] = [];
  let parent = lastUuid;
  let n = 0;
  const shell = (task: string, command: string, seconds: number): void => {
    const call = `toolu_fixture_${task}`;
    const ask = `fixture-shell-${++n}`;
    const answer = `fixture-shell-${++n}`;
    rows.push(
      {
        sessionId,
        cwd,
        timestamp: when(seconds),
        parentUuid: parent,
        uuid: ask,
        type: 'assistant',
        message: {
          id: `msg_fixture_${task}`,
          model: 'claude-opus-5',
          role: 'assistant',
          content: [{ type: 'tool_use', id: call, name: 'Bash', input: { command, run_in_background: true } }],
        },
      },
      {
        sessionId,
        cwd,
        timestamp: when(seconds + 1),
        parentUuid: ask,
        uuid: answer,
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: call,
              content: `Command running in background with ID: ${task}. Output is being written to: /tmp/${task}.output`,
            },
          ],
        },
        toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: task },
      },
    );
    parent = answer;
  };
  shell(OVER, 'cd server && cargo test > /tmp/cargo-test.log 2>&1; echo "EXIT:$?" >> /tmp/cargo-test.log', 0);
  shell(STILL, 'until grep -q "EXIT:" /tmp/cargo-test.log; do sleep 5; done; echo done', 5);
  // The kit's own note, and its two echoes: written once on enqueue, again on
  // delivery and again on removal. Only the first is an ending.
  const note = [
    '<task-notification>',
    `<task-id>${OVER}</task-id>`,
    `<tool-use-id>toolu_fixture_${OVER}</tool-use-id>`,
    `<output-file>/tmp/${OVER}.output</output-file>`,
    '<status>completed</status>',
    '<summary>Background command "Full cargo test" completed (exit code 0)</summary>',
    '</task-notification>',
  ].join('\n');
  rows.push(
    { type: 'queue-operation', operation: 'enqueue', timestamp: when(90), sessionId, content: note },
    { type: 'queue-operation', operation: 'remove', timestamp: when(95), sessionId, content: note },
  );
  appendFileSync(record, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

// Reading a chat back off the disk is a page load, a list and a transcript.
test.setTimeout(120_000);

test('a shell the kit has written an ending for is over on the panel, beside one it has not', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  discardFixture(RUN);
  mkdirSync(RUN, { recursive: true });
  makeFixtureProject(PROJECT, join(RUN, 'reports'));
  const project = await projectAt(request, 'workbench-finished-shell', PROJECT);
  const written = writeChatWithHelper({ cwd: PROJECT, sessionId: randomUUID(), card: PARENT_CARD });
  // The chat's last row, which the fixture names `fixture-u4` for one helper.
  leaveTwoShellsRunning(written.path, written.sessionId, PROJECT, 'fixture-u4');

  try {
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-external-id="${written.sessionId}"]`);
    await row.waitFor({ timeout: OPEN_MS });
    await row.getByTestId('row-name').click();
    await page.getByTestId('chat-tab').waitFor({ timeout: OPEN_MS });

    const panel = page.getByTestId('sent-away-panel');
    await expect(panel).toBeVisible({ timeout: OPEN_MS });
    const over = panel.locator(`[data-testid="sent-away-row"][data-agent="${OVER}"]`);
    const still = panel.locator(`[data-testid="sent-away-row"][data-agent="${STILL}"]`);
    // The one the kit ended is done, in the kit's own words. The other is not:
    // a chat read off the disk is asleep, and the fold says of anything still
    // out in an asleep chat that it lost sight of it (fold.ts, bw-t26l.20) —
    // which is what BOTH rows said before the note was read.
    await expect(over, 'the shell the kit said was over is not done').toHaveAttribute('data-state', 'done', {
      timeout: OPEN_MS,
    });
    await expect(still, 'a shell nobody has ended was finished by guesswork').toHaveAttribute('data-state', 'stopped');

    // Finished rows live behind the panel's fold; open it so the picture shows
    // both, then let the fold land before the shot.
    await page.getByTestId('toggle-stopped-agents').click();
    // A shell's row carries no result paragraph (sent-away.tsx, bw-sb5g.2), so
    // the standing on the row is the whole of what the screen says about it.
    await expect(over).toBeVisible();
    await expect(still).toBeVisible();
    await page.waitForTimeout(400);
    await page
      .getByTestId('chat-right-rail')
      .screenshot({ path: 'tests/results/bw-3cmk-finished-shell.png', animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    discardFixture(RUN);
  }
});
