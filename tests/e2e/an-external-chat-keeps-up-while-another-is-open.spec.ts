import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * An external chat that goes on being written while the person is reading a
 * different one.
 *
 * The manager reported external chats that stop streaming and then arrive all
 * at once, and a status that reads idle when the chat is anything but. What is
 * on the provider's disk is the truth; this holds the app to catching up with
 * it promptly and exactly once, whichever chat is on screen (bw-t26l.22).
 */
const WATCHED = {
  thread: '01a18570-0e7b-7a02-b871-d58e399ef010',
  turn: '01a18570-4b23-76b2-b68f-0f274341a010',
  prompt: 'Say something in the chat that stays open.',
  answer: 'The chat that stays open answered first.',
  asked: 'Carry on in the terminal while I read something else.',
  later: 'A second answer arrived while another chat was on screen.',
  file: 'rollout-2026-09-02T10-00-00-01a18570-0e7b-7a02-b871-d58e399ef010.jsonl',
  at: '2026-09-02T05:00:00.000Z',
};
const OTHER = {
  thread: '01a18571-0e7b-7a02-b871-d58e399ef011',
  turn: '01a18571-4b23-76b2-b68f-0f274341a011',
  prompt: 'Say something in the chat that is on screen.',
  answer: 'The chat on screen answered.',
  file: 'rollout-2026-09-02T11-00-00-01a18571-0e7b-7a02-b871-d58e399ef011.jsonl',
  at: '2026-09-02T06:00:00.000Z',
};

const FIXTURE = join(__dirname, '..', '.workbench-run-codex-keeping-up');

function sessions(): string {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) throw new Error('CODEX_HOME must name the isolated E2E Codex home');
  const directory = join(codexHome, 'sessions', '2026', '09', '02');
  mkdirSync(directory, { recursive: true });
  return directory;
}

function firstTurn(chat: { thread: string; turn: string; prompt: string; answer: string; at: string }): string {
  const start = Date.parse(chat.at);
  const at = (offset: number): string => new Date(start + offset).toISOString();
  const rows = [
    {
      timestamp: at(0), type: 'session_meta',
      payload: {
        id: chat.thread, timestamp: at(0), cwd: FIXTURE, originator: 'codex-tui',
        cli_version: '0.152.0', source: 'cli', model_provider: 'openai',
      },
    },
    {
      timestamp: at(500), type: 'turn_context',
      payload: { cwd: FIXTURE, approval_policy: 'on-request', model: 'gpt-5.4', reasoning_effort: 'high' },
    },
    { timestamp: at(1000), type: 'event_msg', payload: { type: 'task_started', turn_id: chat.turn, model_context_window: 258_400 } },
    { timestamp: at(1100), type: 'event_msg', payload: { type: 'user_message', id: 'person-1', message: chat.prompt, images: [], local_images: [] } },
    { timestamp: at(2000), type: 'event_msg', payload: { type: 'agent_message', message: chat.answer, phase: 'final_answer' } },
    {
      timestamp: at(2000), type: 'response_item',
      payload: { type: 'message', id: 'answer-1', role: 'assistant', content: [{ type: 'output_text', text: chat.answer }], phase: 'final_answer' },
    },
    { timestamp: at(2100), type: 'event_msg', payload: { type: 'task_complete', turn_id: chat.turn, last_agent_message: chat.answer } },
  ];
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function laterTurn(): string {
  const start = Date.parse(WATCHED.at) + 60_000;
  const at = (offset: number): string => new Date(start + offset).toISOString();
  const turn = `${WATCHED.turn.slice(0, -1)}b`;
  const rows = [
    { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: turn, model_context_window: 258_400 } },
    { timestamp: at(100), type: 'event_msg', payload: { type: 'user_message', id: 'person-2', message: WATCHED.asked, images: [], local_images: [] } },
    { timestamp: at(1000), type: 'event_msg', payload: { type: 'agent_message', message: WATCHED.later, phase: 'final_answer' } },
    {
      timestamp: at(1000), type: 'response_item',
      payload: { type: 'message', id: 'answer-2', role: 'assistant', content: [{ type: 'output_text', text: WATCHED.later }], phase: 'final_answer' },
    },
    { timestamp: at(1100), type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: WATCHED.later } },
  ];
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

test('an external chat that grows while another is on screen is caught up when it is opened', async ({ page, request }) => {
  test.setTimeout(90_000);
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  const directory = sessions();
  writeFileSync(join(directory, WATCHED.file), firstTurn(WATCHED));
  writeFileSync(join(directory, OTHER.file), firstTurn(OTHER));

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'Codex keeping-up fixture', path: FIXTURE, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);

    const rowOf = (thread: string) => page.locator(`[data-testid="restore-row"][data-external-id="${thread}"]`);
    await expect(rowOf(WATCHED.thread)).toBeVisible({ timeout: 30_000 });
    await expect(rowOf(OTHER.thread)).toBeVisible({ timeout: 30_000 });

    // Read the one that will grow, then leave it for the other one.
    await rowOf(WATCHED.thread).getByTestId('row-name').click();
    await expect(page.getByTestId('assistant-message').filter({ hasText: WATCHED.answer })).toHaveCount(1);
    await rowOf(OTHER.thread).getByTestId('row-name').click();
    await expect(page.getByTestId('assistant-message').filter({ hasText: OTHER.answer })).toHaveCount(1);

    // Whatever else is on screen, the provider goes on writing.
    appendFileSync(join(directory, WATCHED.file), laterTurn());

    // The list must say so without being asked to open anything. The row's
    // clock is dated by the chat's last word, so a chat that spoke a minute
    // later reads a minute later (bw-zhs9).
    await expect(rowOf(WATCHED.thread).locator('span.font-mono').first())
      .toHaveText('10:01 AM', { timeout: 15_000 });

    const openedAt = Date.now();
    await rowOf(WATCHED.thread).getByTestId('row-name').click();
    const later = page.getByTestId('assistant-message').filter({ hasText: WATCHED.later });
    await expect(later).toHaveCount(1, { timeout: 15_000 });
    expect(Date.now() - openedAt, 'catching up on an external chat that grew').toBeLessThan(1_000);
    await expect(page.getByTestId('assistant-message').filter({ hasText: WATCHED.answer })).toHaveCount(1);
    await expect(page.getByTestId('user-message').filter({ hasText: WATCHED.asked })).toHaveCount(1);
    // And it stays said. Reading a chat is not a thing that happened in it, so
    // nothing about opening one may put its clock back to the turn before the
    // one on screen.
    await expect(rowOf(WATCHED.thread).locator('span.font-mono').first()).toHaveText('10:01 AM');
    if (process.env.WORKBENCH_E2E_SHOT) {
      await page.locator('[data-testid="chat-sidebar"], aside').first()
        .screenshot({ path: process.env.WORKBENCH_E2E_SHOT });
    }
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
