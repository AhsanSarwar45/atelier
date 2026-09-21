/**
 * A chat that fell asleep before its first message was ever sent.
 *
 * Open a chat, start writing, and the provider session it was given is one
 * nothing has used yet. A provider need not write such a session down — the
 * bundled claude adapter does not, and there is no record of it anywhere on
 * disk — so when the chat falls asleep while the message is still being
 * typed, the id it holds names nothing. The send that follows cannot take the
 * conversation up again, and the chat ended in red with the wire's own words:
 *
 *   Resource not found: a22f34ef-a523-4ad5-a87b-1db7aec91a41: {
 *     "uri": "a22f34ef-a523-4ad5-a87b-1db7aec91a41"
 *   }
 *
 * The manager, with a picture of it: "sometime i get this error. error should
 * be user understandable. but such an error shouldnt occur in firat place"
 * (bw-m15v).
 *
 * Live, because the thing under test is what a real provider does with an id
 * it never wrote down. A seeded record cannot forget anything.
 *
 *   BEADS_E2E_LIVE_PROVIDERS=1 scripts/workbench-e2e.sh tests/e2e/a-forgotten-session-sends-anyway.spec.ts
 *
 * The other half of the pair is the same run against the build before the fix
 * — THE_CHAT_DREW_THE_WIRES_REFUSAL=1 says which picture is being taken and
 * what the screen is expected to say.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-forgotten-session');
const SHOTS = 'tests/results';
const TURN_MS = 600_000;
const SETTLE_MS = 120_000;
/** The build that drew the refusal instead of sending, which is the complaint. */
const REFUSED = Boolean(process.env.THE_CHAT_DREW_THE_WIRES_REFUSAL);
const SHOT = REFUSED ? 'bw-m15v-before' : 'bw-m15v-after';
/** Short, so the answer is the whole of the turn and arrives as one word. */
const ASKED = 'Reply with exactly the one word AWAKE. Do not do anything else.';

test.describe('a chat whose provider forgot its session', () => {
  test.describe.configure({ mode: 'serial', timeout: TURN_MS });

  test.skip(
    process.env.BEADS_E2E_LIVE_PROVIDERS !== '1',
    'needs a live provider: only a real one can forget an id it never wrote down',
  );

  test.beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });

  test('sends the message it was holding instead of drawing the wire at the reader', async ({ page, request }) => {
    let project: Project | undefined;
    try {
      const path = join(ROOT, 'forgotten-session');
      mkdirSync(path, { recursive: true });
      const made = await request.post('/api/projects', {
        data: { name: 'forgotten-session', path, isTest: true },
      });
      expect(made.status(), await made.text()).toBe(201);
      project = (await made.json()) as Project;

      // A chat, and nothing said in it: exactly what is open while a message
      // is being written.
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

      // And now it falls asleep, with the id it was given never used and so
      // never written down. This is the whole of the setup: nothing is
      // tampered with, the provider simply has no record to come back to.
      const stopped = await request.post('/api/workbench/command', {
        data: { type: 'session.stop', sessionId },
      });
      expect(stopped.ok(), await stopped.text()).toBe(true);

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const url = new URL(route.request().url());
        url.searchParams.set('include_test', 'true');
        await route.continue({ url: url.toString() });
      });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: SETTLE_MS });

      await request.post('/api/workbench/command', {
        data: { type: 'prompt.send', sessionId, text: ASKED },
      });

      if (REFUSED) {
        // The complaint itself: a message that never went anywhere, and a
        // sentence written for a log standing where the answer should be.
        const refusal = page.getByText('Resource not found').first();
        await expect(refusal).toBeVisible({ timeout: SETTLE_MS });
        await page.screenshot({ path: `${SHOTS}/${SHOT}.png` });
        await expect(refusal).toContainText('uri');
        return;
      }

      // The whole of the fix: the message goes, and is answered.
      await expect(page.getByTestId('assistant-message').last()).toContainText('AWAKE', {
        timeout: SETTLE_MS,
      });
      await page.screenshot({ path: `${SHOTS}/${SHOT}.png` });

      // Nothing of the wire reaches the reader: not the code's name, not the
      // id, not the object it was hung off.
      await expect(page.getByText('Resource not found')).toHaveCount(0);
      await expect(page.getByText('"uri"')).toHaveCount(0);
      // And nothing is said about a lost conversation, because this chat had
      // no conversation to lose — it had drawn nothing at all.
      await expect(page.getByText('no longer has this conversation')).toHaveCount(0);
    } finally {
      if (project) await request.delete(`/api/projects/${project.id}`);
    }
  });
});
