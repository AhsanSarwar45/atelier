/**
 * A chat of ours, mid-turn, saying which of the things it is doing.
 *
 * The ported driver wrote one standing when the prompt was sent — `streaming`,
 * labelled "Working" — and the next one when the turn ENDED, so a turn that
 * thought, ran a build and came back drew the one word for all of it, at the
 * foot of the transcript and on the row in the rail alike. The manager, of the
 * ported build: "before the node->rust/acp port we had the status showing
 * actual information like what command or action each session was doing (both
 * in the sidebar and in the chat transcript at the bottom). now it only says
 * 'working'" (bw-xfb4).
 *
 * Live, because the thing under test is what a real driver PUTS IN THE RECORD
 * while a real call is in flight — a seeded record cannot prove it, and a chat
 * with no driver alive is written back to `dormant` the moment it is opened.
 * The agent is asked for one long command and nothing else, so the moment the
 * picture is taken is a moment that lasts.
 *
 *   BEADS_E2E_LIVE_PROVIDERS=1 scripts/workbench-e2e.sh tests/e2e/a-working-chat-says-what-it-is-doing.spec.ts
 *
 * The other half of the pair is the same run against the build before this fix
 * — THE_TURN_ONLY_SAID_WORKING=1 says which picture is being taken and what the
 * screen is expected to say.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-says-what-it-is-doing');
const SHOTS = 'tests/results';
const TURN_MS = 600_000;
const SETTLE_MS = 120_000;
/**
 * The call in flight: what the reader wants named, and long enough to
 * photograph. Not a bare `sleep`, which the sandbox refuses — the agent said
 * so and stopped rather than run anything at all.
 */
const RAN = "python3 -c 'import time; time.sleep(45)'";
/** The build that only ever said Working, which is the picture of the complaint. */
const ONLY_WORKING = Boolean(process.env.THE_TURN_ONLY_SAID_WORKING);

test.describe('a working chat says what it is doing', () => {
  test.describe.configure({ mode: 'serial', timeout: TURN_MS });

  test.beforeAll(() => {
    expect(process.env.BEADS_E2E_LIVE_PROVIDERS, 'set BEADS_E2E_LIVE_PROVIDERS=1').toBe('1');
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });

  test('the command in flight is named at the foot of the chat and on its row', async ({ page, request }) => {
    let project: Project | undefined;
    try {
      const path = join(ROOT, 'says-what-it-is-doing');
      mkdirSync(path, { recursive: true });
      const made = await request.post('/api/projects', {
        data: { name: 'says-what-it-is-doing', path, isTest: true },
      });
      expect(made.status(), await made.text()).toBe(201);
      project = (await made.json()) as Project;

      const started = await request.post('/api/workbench/command', {
        data: {
          type: 'session.start',
          projectId: project.id,
          projectPath: project.path,
          brand: 'claude',
          permissionMode: 'bypassPermissions',
        },
      });
      expect(started.ok(), await started.text()).toBe(true);
      const sessionId = ((await started.json()) as { id: string }).id;

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const url = new URL(route.request().url());
        url.searchParams.set('include_test', 'true');
        await route.continue({ url: url.toString() });
      });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: SETTLE_MS });

      const sent = await request.post('/api/workbench/command', {
        data: {
          type: 'prompt.send',
          sessionId,
          text:
            `Run exactly one Bash command: ${RAN}\n` +
            'When it returns, reply exactly SLEPT.\n' +
            'Do not read any file, do not run any other command, and do not say anything else.',
        },
      });
      expect(sent.ok(), await sent.text()).toBe(true);

      // The foot of the transcript: the line a reader watches while they wait.
      // Drawn either way — the question the pair of pictures answers is what it
      // is allowed to say while the command runs.
      const line = page.getByTestId('working-line');
      await expect(line).toBeVisible({ timeout: SETTLE_MS });
      // The other half of what the manager named: the row in the rail, which is
      // what he sees for the forty chats he does not have open.
      const row = page.locator(`[data-testid="restore-row"][data-row-key="${sessionId}"]`);
      const pill = row.getByTestId('row-pill');
      await expect(pill).toBeVisible({ timeout: SETTLE_MS });

      // Both pictures are of the same moment of the same turn: the command
      // running, its card open on the transcript above the line being read.
      // Taken any earlier and the before-shot would be of a chat that had not
      // started work yet, which says nothing about what it hides once it has.
      await expect(page.getByTestId('tool-toggle').filter({ hasText: 'time.sleep' })).toBeVisible({
        timeout: SETTLE_MS,
      });
      await expect(line).toContainText(ONLY_WORKING ? 'Working' : 'Running', { timeout: SETTLE_MS });
      // Taken before the readings below, so a build that draws this wrong
      // leaves the picture of what it drew and not only the sentence that
      // failed.
      await page.screenshot({ path: `${SHOTS}/${ONLY_WORKING ? 'bw-xfb4-before.png' : 'bw-xfb4-after.png'}` });

      if (ONLY_WORKING) {
        // The complaint itself: a chat that has been running one command for
        // three quarters of a minute, saying only that it is busy, in both
        // places at once.
        await expect(line).not.toContainText(RAN);
        await expect(pill).toHaveAttribute('data-word', 'Working');
        await expect(row.getByTestId('chat-state-detail')).toHaveCount(0);
        return;
      }

      // And the whole of the fix: the call in flight, named, where the word
      // alone used to stand — at the foot of the transcript and on the row in
      // the rail, in the same words, because both are drawn from the one
      // reading (chat-state.ts).
      await expect(line, 'the chat says it is working without saying what at').toContainText(RAN);
      await expect(pill).toHaveAttribute('data-word', 'Running');
      await expect(row.getByTestId('chat-state-detail')).toContainText(RAN);

      // And it gives the command up when the call is over, rather than standing
      // there naming something that finished a minute ago.
      await expect(page.getByTestId('assistant-message').last()).toContainText('SLEPT', { timeout: SETTLE_MS });
      await expect(line).toBeHidden({ timeout: SETTLE_MS });
    } finally {
      if (project) await request.delete(`/api/projects/${project.id}`);
    }
  });
});
