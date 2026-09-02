import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const THREAD = '01a18555-0e7b-7a02-b871-d58e399effd1';
const TURN = '01a18555-4b23-76b2-b68f-0f274341a124';
const PROMPT = 'Please keep this prompt visible when I reopen the chat.';
const ANSWER = 'The prompt should be directly above this answer.';
const TITLE = 'Keep Prompt Visible When Reopen Chat';
const FIXTURE = join(__dirname, '..', '.workbench-run-codex-history');

function installRollout(): void {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) throw new Error('CODEX_HOME must name the isolated E2E Codex home');
  const directory = join(codexHome, 'sessions', '2026', '09', '02');
  mkdirSync(directory, { recursive: true });
  const rows = [
    {
      timestamp: '2026-09-02T05:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: THREAD,
        timestamp: '2026-09-02T05:00:00.000Z',
        cwd: FIXTURE,
        originator: 'codex-tui',
        cli_version: '0.152.0',
        source: 'cli',
        model_provider: 'openai',
      },
    },
    {
      timestamp: '2026-09-02T05:00:00.500Z',
      type: 'turn_context',
      payload: {
        cwd: FIXTURE,
        approval_policy: 'on-request',
        model: 'gpt-5.4',
        reasoning_effort: 'high',
      },
    },
    {
      timestamp: '2026-09-02T05:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: TURN, model_context_window: 258_400 },
    },
    {
      timestamp: '2026-09-02T05:00:01.100Z',
      type: 'event_msg',
      payload: { type: 'user_message', id: 'person-1', message: PROMPT, images: [], local_images: [] },
    },
    {
      timestamp: '2026-09-02T05:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: ANSWER, phase: 'final_answer' },
    },
    {
      timestamp: '2026-09-02T05:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'answer-1',
        role: 'assistant',
        content: [{ type: 'output_text', text: ANSWER }],
        phase: 'final_answer',
      },
    },
    {
      timestamp: '2026-09-02T05:00:02.100Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: TURN, last_agent_message: ANSWER },
    },
  ];
  writeFileSync(
    join(directory, `rollout-2026-09-02T10-00-00-${THREAD}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

test('the Rust Codex importer restores one ordered copy of the person and agent messages', async ({ page, request }) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  installRollout();
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'Codex history fixture', path: FIXTURE, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();

    await page.goto(`/project?id=${project!.id}&tab=chat`);
    const row = page.locator(`[data-testid="restore-row"][data-external-id="${THREAD}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByTestId('row-name')).toHaveText(TITLE);

    const openedAt = performance.now();
    await row.getByTestId('row-name').click();
    const prompt = page.getByTestId('user-message').filter({ hasText: PROMPT });
    const answer = page.getByTestId('assistant-message').filter({ hasText: ANSWER });
    await expect(prompt).toHaveCount(1);
    await expect(answer).toHaveCount(1);
    await expect(page.getByTestId('chat-loading')).toHaveCount(0);
    expect(performance.now() - openedAt, 'cold click-to-correct Codex transcript').toBeLessThan(500);

    const order = await page.locator('[data-testid="transcript-rows"] [data-testid$="-message"]').evaluateAll(
      (messages, expected) => messages
        .filter((message) => message.textContent?.includes(expected.prompt) || message.textContent?.includes(expected.answer))
        .map((message) => message.getAttribute('data-testid')),
      { prompt: PROMPT, answer: ANSWER },
    );
    expect(order).toEqual(['user-message', 'assistant-message']);

    await expect(page.getByTestId('model-picker')).toBeVisible();
    await expect(page.getByTestId('model-picker')).toBeEnabled();
    await expect(page.getByTestId('restore-error')).toHaveCount(0);
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
