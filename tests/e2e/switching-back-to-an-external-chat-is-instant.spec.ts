import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * Two saved Codex chats, opened one after the other and then switched back
 * between.
 *
 * The first open of an external chat reads the provider's record; the second
 * must not. The manager reported external chats that "take ages to load" and
 * that switching between them is nothing like instant, and the store already
 * knows everything needed to draw one it has read once (bw-t26l.22).
 */
const CHATS = [
  {
    thread: '01a18560-0e7b-7a02-b871-d58e399ef001',
    turn: '01a18560-4b23-76b2-b68f-0f274341a001',
    prompt: 'Ask the first chat something worth keeping.',
    answer: 'The first chat kept its answer.',
    title: 'Ask First Chat Something Worth Keeping',
    at: '2026-09-02T05:00:00.000Z',
    file: 'rollout-2026-09-02T10-00-00-01a18560-0e7b-7a02-b871-d58e399ef001.jsonl',
  },
  {
    thread: '01a18561-0e7b-7a02-b871-d58e399ef002',
    turn: '01a18561-4b23-76b2-b68f-0f274341a002',
    prompt: 'Ask the second chat something else.',
    answer: 'The second chat kept its own answer.',
    title: 'Ask Second Chat Something Else',
    at: '2026-09-02T06:00:00.000Z',
    file: 'rollout-2026-09-02T11-00-00-01a18561-0e7b-7a02-b871-d58e399ef002.jsonl',
  },
] as const;

const FIXTURE = join(__dirname, '..', '.workbench-run-codex-switching');

function installRollouts(): void {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) throw new Error('CODEX_HOME must name the isolated E2E Codex home');
  const directory = join(codexHome, 'sessions', '2026', '09', '02');
  mkdirSync(directory, { recursive: true });
  for (const chat of CHATS) {
    const start = Date.parse(chat.at);
    const at = (offset: number): string => new Date(start + offset).toISOString();
    const rows = [
      {
        timestamp: at(0),
        type: 'session_meta',
        payload: {
          id: chat.thread, timestamp: at(0), cwd: FIXTURE, originator: 'codex-tui',
          cli_version: '0.152.0', source: 'cli', model_provider: 'openai',
        },
      },
      {
        timestamp: at(500),
        type: 'turn_context',
        payload: { cwd: FIXTURE, approval_policy: 'on-request', model: 'gpt-5.4', reasoning_effort: 'high' },
      },
      {
        timestamp: at(1000),
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: chat.turn, model_context_window: 258_400 },
      },
      {
        timestamp: at(1100),
        type: 'event_msg',
        payload: { type: 'user_message', id: 'person-1', message: chat.prompt, images: [], local_images: [] },
      },
      {
        timestamp: at(2000),
        type: 'event_msg',
        payload: { type: 'agent_message', message: chat.answer, phase: 'final_answer' },
      },
      {
        timestamp: at(2000),
        type: 'response_item',
        payload: {
          type: 'message', id: 'answer-1', role: 'assistant',
          content: [{ type: 'output_text', text: chat.answer }], phase: 'final_answer',
        },
      },
      {
        timestamp: at(2100),
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: chat.turn, last_agent_message: chat.answer },
      },
    ];
    writeFileSync(join(directory, chat.file), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  }
}

test('switching back to an external chat the app has already read is instant', async ({ page, request }) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  installRollouts();
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'Codex switching fixture', path: FIXTURE, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);

    const rowOf = (thread: string) => page.locator(`[data-testid="restore-row"][data-external-id="${thread}"]`);
    const said = (chat: (typeof CHATS)[number]) => ({
      prompt: page.getByTestId('user-message').filter({ hasText: chat.prompt }),
      answer: page.getByTestId('assistant-message').filter({ hasText: chat.answer }),
    });

    for (const chat of CHATS) {
      await expect(rowOf(chat.thread)).toBeVisible({ timeout: 30_000 });
    }

    // Read both of them once, the slow way, through the provider's record.
    for (const chat of CHATS) {
      await rowOf(chat.thread).getByTestId('row-name').click();
      const { prompt, answer } = said(chat);
      await expect(prompt).toHaveCount(1);
      await expect(answer).toHaveCount(1);
      await expect(page.getByTestId('chat-loading')).toHaveCount(0);
    }

    // Take the provider's records away. A chat this app has read once is the
    // app's own; needing the file again to draw it is the bug this covers.
    const codexHome = process.env.CODEX_HOME!;
    for (const chat of CHATS) {
      rmSync(join(codexHome, 'sessions', '2026', '09', '02', chat.file), { force: true });
    }

    // Now switch between them. Nothing here needs the provider again.
    for (const chat of [CHATS[0], CHATS[1], CHATS[0]]) {
      const openedAt = Date.now();
      await rowOf(chat.thread).getByTestId('row-name').click();
      const { prompt, answer } = said(chat);
      await expect(prompt).toHaveCount(1);
      await expect(answer).toHaveCount(1);
      expect(
        Date.now() - openedAt,
        `switching back to “${chat.title}” was not instant`,
      ).toBeLessThan(300);
      // The other chat's words must not be in this one.
      const other = chat === CHATS[0] ? CHATS[1] : CHATS[0];
      await expect(page.getByTestId('user-message').filter({ hasText: other.prompt })).toHaveCount(0);
    }
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
