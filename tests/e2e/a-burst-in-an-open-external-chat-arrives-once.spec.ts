import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * Four hundred turns written into a chat that is open on screen, in two bursts.
 *
 * The complaint this run stands against: external chats that "randomly stop
 * streaming and then stream massive amounts of messages at once". The dump is
 * hard to hold still, but what a dump would break is not: the follower re-reads
 * a rolling window of the record on every beat, so the same line is replayed
 * many times over, and what keeps it from being said many times over is the
 * event identity the provider row is given. A burst is where that identity is
 * asked the hardest — a hundred turns landing between two beats, every one of
 * them inside the window on the next beat too.
 *
 * So: every turn arrives, promptly, and each exactly once.
 */
const CHAT = {
  thread: '01a18572-0e7b-7a02-b871-d58e399ef012',
  turn: '01a18572-4b23-76b2-b68f-0f274341a012',
  prompt: 'Say something before the burst.',
  answer: 'The chat answered before the burst.',
  file: 'rollout-2026-09-02T12-00-00-01a18572-0e7b-7a02-b871-d58e399ef012.jsonl',
  at: '2026-09-02T07:00:00.000Z',
};
const BURST = 200;
// A second burst, after the first has been read. The follower keeps a window
// of the last 512 rows of the record and re-reads all of it on every beat; a
// burst this size pushes the first one out of that window, so the second is
// read starting from a point that is in the middle of a turn.
const AGAIN = 200;
const FIXTURE = join(__dirname, '..', '.workbench-run-codex-burst');

function sessions(): string {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) throw new Error('CODEX_HOME must name the isolated E2E Codex home');
  const directory = join(codexHome, 'sessions', '2026', '09', '02');
  mkdirSync(directory, { recursive: true });
  return directory;
}

const rows = (list: object[]): string => `${list.map((row) => JSON.stringify(row)).join('\n')}\n`;

function firstTurn(): string {
  const start = Date.parse(CHAT.at);
  const at = (offset: number): string => new Date(start + offset).toISOString();
  return rows([
    {
      timestamp: at(0), type: 'session_meta',
      payload: {
        id: CHAT.thread, timestamp: at(0), cwd: FIXTURE, originator: 'codex-tui',
        cli_version: '0.152.0', source: 'cli', model_provider: 'openai',
      },
    },
    {
      timestamp: at(500), type: 'turn_context',
      payload: { cwd: FIXTURE, approval_policy: 'on-request', model: 'gpt-5.4', reasoning_effort: 'high' },
    },
    { timestamp: at(1000), type: 'event_msg', payload: { type: 'task_started', turn_id: CHAT.turn, model_context_window: 258_400 } },
    { timestamp: at(1100), type: 'event_msg', payload: { type: 'user_message', id: 'person-1', message: CHAT.prompt, images: [], local_images: [] } },
    { timestamp: at(2000), type: 'event_msg', payload: { type: 'agent_message', message: CHAT.answer, phase: 'final_answer' } },
    {
      timestamp: at(2000), type: 'response_item',
      payload: { type: 'message', id: 'answer-1', role: 'assistant', content: [{ type: 'output_text', text: CHAT.answer }], phase: 'final_answer' },
    },
    { timestamp: at(2100), type: 'event_msg', payload: { type: 'task_complete', turn_id: CHAT.turn, last_agent_message: CHAT.answer } },
  ]);
}

const TOTAL = BURST + AGAIN;
const said = (n: number): string => `burst answer number ${n} of ${TOTAL}`;

function burst(from: number, to: number): string {
  const start = Date.parse(CHAT.at) + 60_000;
  const all: object[] = [];
  for (let n = from; n <= to; n += 1) {
    const at = (offset: number): string => new Date(start + n * 1_000 + offset).toISOString();
    const turn = `${CHAT.turn.slice(0, -3)}${String(n).padStart(3, '0')}`;
    all.push(
      { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: turn, model_context_window: 258_400 } },
      { timestamp: at(100), type: 'event_msg', payload: { type: 'user_message', id: `person-${n}`, message: `burst question number ${n}`, images: [], local_images: [] } },
      { timestamp: at(200), type: 'event_msg', payload: { type: 'agent_message', message: said(n), phase: 'final_answer' } },
      {
        timestamp: at(200), type: 'response_item',
        payload: { type: 'message', id: `burst-${n}`, role: 'assistant', content: [{ type: 'output_text', text: said(n) }], phase: 'final_answer' },
      },
      { timestamp: at(300), type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: said(n) } },
    );
  }
  return rows(all);
}

test('two bursts written at once into an open external chat all arrive, each once', async ({ page, request }) => {
  test.setTimeout(120_000);
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  const directory = sessions();
  writeFileSync(join(directory, CHAT.file), firstTurn());

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'Codex burst fixture', path: FIXTURE, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);

    const row = page.locator(`[data-testid="restore-row"][data-external-id="${CHAT.thread}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('assistant-message').filter({ hasText: CHAT.answer })).toHaveCount(1);

    // The terminal writes two hundred turns in one go, with the chat on screen.
    const written = Date.now();
    appendFileSync(join(directory, CHAT.file), burst(1, BURST));

    // The last of them is the one that says the whole burst landed.
    await expect(page.getByTestId('assistant-message').filter({ hasText: said(BURST) }))
      .toHaveCount(1, { timeout: 30_000 });

    // And now a second one, on top of a window that is already full.
    appendFileSync(join(directory, CHAT.file), burst(BURST + 1, TOTAL));
    await expect(page.getByTestId('assistant-message').filter({ hasText: said(TOTAL) }))
      .toHaveCount(1, { timeout: 30_000 });
    const took = Date.now() - written;

    // And not one of them twice. The window the follower re-reads is 512 rows
    // and the burst is 500, so every line in it is replayed on the beat after
    // the one that first carried it. Ask the chat's own history rather than the
    // screen: the transcript is virtualized, so what is drawn is only what fits.
    const session = await page.locator('[data-testid="chat-tab"]').getAttribute('data-session-id');
    expect(session, 'the open chat names its session').toBeTruthy();
    const seen = new Map<string, number>();
    let before = Number.MAX_SAFE_INTEGER;
    for (let page_ = 0; page_ < 200; page_ += 1) {
      const got = await request.get(`/api/workbench/history?session=${session}&before=${before}`);
      expect(got.ok(), await got.text()).toBe(true);
      const body = (await got.json()) as { items: unknown[]; cursor: number | null; hasOlder: boolean };
      for (const item of body.items) {
        const text = JSON.stringify(item);
        for (const found of text.matchAll(/burst answer number (\d+) of/g)) {
          const key = found[1];
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
      if (!body.hasOlder || body.cursor === null || body.cursor === undefined) break;
      before = body.cursor;
    }
    const twice = [...seen.entries()].filter(([, count]) => count > 1);
    expect(twice, `answers drawn more than once: ${JSON.stringify(twice)}`).toEqual([]);
    const missing = Array.from({ length: TOTAL }, (_, i) => String(i + 1)).filter((n) => !seen.has(n));
    expect(missing, `answers that never arrived: ${missing.join(', ')}`).toEqual([]);

    expect(took, `${TOTAL} turns took ${took}ms to arrive in an open chat`).toBeLessThan(15_000);
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
