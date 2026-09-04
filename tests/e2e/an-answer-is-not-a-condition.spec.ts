import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { configDir, projectSlug } from './fixture-record';

/**
 * An answer that talks about a condition is drawn as an answer.
 *
 * The manager sent three screenshots of his own chats on 2026-09-04. In each
 * one his answer was gone from the page, replaced by a bordered notice naming
 * something that had not happened: `Sign in to continue` over an answer about a
 * sidebar chip, `This model is unavailable` over one about a local model
 * server, `This conversation is out of context space` over one about a search
 * tool that saves context. Two of the three chats wore `FAILED` in the list and
 * the third `STOPPED`. "normal agent messages (non-tool calls) should never be
 * categorized".
 *
 * They were, because the reading that turns a kit's prose into a condition ran
 * over the text of every completed assistant message rather than over what the
 * kit says when something has actually gone wrong (bw-7pfr).
 *
 * Written as a record on disk rather than driven live, for the reason the fault
 * needs: the reading happened at the boundary that normalises a turn, so a chat
 * whose events were seeded already normalised would prove nothing about it.
 * This one arrives as a record the kit wrote, is replayed through this build's
 * own normalizer on the way in, and is read back off the screen — the same
 * journey his own three took, and the reason they came back wrong every time he
 * opened them.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/an-answer-is-not-a-condition.spec.ts
 */

const FIXTURE = join(process.cwd(), 'tests', '.workbench-run-answer-not-condition');
const SHOTS = join(process.cwd(), 'tests', 'results');
const CHAT = '7fbca210-8c31-4f0e-9a5b-3a4d2e1c9b70';

/**
 * What the kit says for itself when a limit really has been hit.
 *
 * Its whole message is that one sentence, and it opens with one of the openings
 * the kit declares in `sdk.d.ts` — so the narrow, opening-anchored reading in
 * `machine-words.ts` files it as the kit speaking rather than as an answer, and
 * quotes it whole. That reading is not what this fixes and not what broke: it
 * takes a WHOLE short message that IS one of those sentences, never a paragraph
 * that mentions one. It is here so the case can show what still works.
 */
const LIMIT = "You've hit your session limit · resets 9pm (Asia/Karachi)";

/**
 * Three answers of his, each one shortened to the sentence that was read as a
 * condition. Every one of them still matches the prose reading — that is the
 * point of the case: what changed is WHERE that reading is allowed to run.
 */
const ANSWERS = [
  {
    kind: 'provider/authentication',
    banner: 'Sign in to continue',
    text:
      "The sidebar now reads the condition's own word — Limit reached, Sign-in required — " +
      'instead of a blanket Failed, proved on the running screen and not just in tests.',
  },
  {
    kind: 'provider/model_unavailable',
    banner: 'This model is unavailable',
    text:
      'Nothing is listening on 8080, so the compiled-in model list comes back unavailable ' +
      'and no model is resident until the router reports one.',
  },
  {
    kind: 'provider/context_limit',
    banner: 'This conversation is out of context space',
    text:
      'TinySearch lets a small model search the web without burning the whole context window, ' +
      'which is what makes web grounding affordable on a 9B.',
  },
] as const;

async function projectAt(request: APIRequestContext, path: string) {
  const made = await request.post('/api/projects', {
    data: { name: 'An answer is not a condition', path },
  });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/** The chat as the kit files one: his question, three answers, then a real failure. */
function writeTheChat(cwd: string): void {
  const dir = join(configDir(), 'projects', projectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  const began = new Date(Date.now() - 60 * 60 * 1000);
  const stamp = (n: number, extra: Record<string, unknown>): Record<string, unknown> => ({
    sessionId: CHAT,
    cwd,
    gitBranch: 'ours',
    version: '2.1.237',
    userType: 'external',
    timestamp: new Date(began.getTime() + n * 1000).toISOString(),
    parentUuid: n === 0 ? null : `answer-u${n - 1}`,
    uuid: `answer-u${n}`,
    ...extra,
  });
  const answered = (n: number, text: string, failed = false): Record<string, unknown> =>
    stamp(n, {
      type: 'assistant',
      ...(failed ? { isApiErrorMessage: true } : {}),
      message: {
        id: `msg_answer_${n}`,
        model: 'claude-opus-5',
        role: 'assistant',
        usage: { input_tokens: 120, output_tokens: 180 },
        content: [{ type: 'text', text }],
      },
    });

  const rows: Record<string, unknown>[] = [
    stamp(0, { type: 'user', message: { role: 'user', content: 'Where did the work get to?' } }),
    ...ANSWERS.map((answer, index) => answered(index + 1, answer.text)),
    // And the one thing on the page that IS a condition: the kit's own error
    // row, which is where the words for one are read.
    answered(ANSWERS.length + 1, LIMIT, true),
  ];
  writeFileSync(join(dir, `${CHAT}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

test.beforeEach(async ({ page }) => {
  // A fixture project is `isTest`, which keeps it off its own browser tab
  // unless the page is asked for test projects too.
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

test('an answer that mentions a condition is drawn as an answer, and only an error as a condition', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });

  const project = await projectAt(request, FIXTURE);
  writeTheChat(FIXTURE);

  const opened = await request.post('/api/workbench/command', {
    data: { type: 'session.open', externalId: CHAT, brand: 'claude', projectId: project.id, projectPath: FIXTURE },
  });
  expect(opened.status(), await opened.text()).toBe(200);
  const sessionId = ((await opened.json()) as { id: string }).id;

  await page.goto(`/project?id=${project.id}&chat=${sessionId}`);
  await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 60_000 });
  const transcript = page.getByTestId('transcript');
  // Waited on by the transcript itself and not by an answer in it: with the
  // reading still running, every answer here was replaced and there was no
  // answer left to wait for — which is the fault, and the shot below has to be
  // able to show it rather than time out in front of it.
  await expect
    .poll(async () => Number(await page.getByTestId('virtual-transcript').getAttribute('data-total-items')), {
      timeout: 60_000,
    })
    .toBeGreaterThan(3);

  await page.screenshot({
    path: join(SHOTS, process.env.ANSWER_WAS_A_CONDITION ? 'bw-7pfr-before.png' : 'bw-7pfr-after.png'),
    fullPage: false,
  });

  for (const answer of ANSWERS) {
    // His words, on the page, in his agent's own voice.
    await expect(
      transcript.getByTestId('assistant-message').filter({ hasText: answer.text.slice(0, 60) }),
      `the answer was taken off the page: ${answer.banner}`,
    ).toHaveCount(1);
    // And no notice standing where it stood.
    await expect(
      page.locator(`[data-testid="note-row"][data-note-kind="${answer.kind}"]`),
      `an answer was filed as ${answer.kind}`,
    ).toHaveCount(0);
    await expect(page.getByText(answer.banner, { exact: false })).toHaveCount(0);
  }

  // And the one message that IS the kit speaking still stands out as a
  // condition, quoted whole, with the hour it lifts — which is the half of this
  // that had to keep working. It is the only note on the page.
  const notes = page.locator('[data-testid="note-row"]');
  await expect(notes, 'the page should carry exactly one condition, and does not').toHaveCount(1);
  await expect(notes).toHaveAttribute('data-note-kind', 'kit/limit_reached');
  await expect(notes).toContainText('resets 9pm (Asia/Karachi)');
  await expect(notes).toHaveAttribute('data-family', 'stopped');
});
