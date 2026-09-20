import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * The review worker's chat is the agents' own, and the sidebar treats it so.
 *
 * `atelier tool review --provider codex` runs `codex exec`, which leaves a
 * rollout behind. A rollout is filed as `"exec"` whoever began it — a person's
 * own `codex exec` run looks exactly the same from the index — so eight review
 * workers were drawn in the owner's sidebar as chats of his own, with the
 * agents' switch off (bw-s7cd). The run now names its own kind in
 * `thread_source`, measured against codex-cli 0.153.4, and the record reader
 * reads that name back.
 *
 * Both rollouts below are `"exec"` runs. Only one of them says it is a
 * subagent's, and that is the only thing separating them: if the reader went
 * back to reading `source` alone, both rows would be drawn and this goes red.
 */

const WORKER = '01a18777-1e7b-7a02-b871-d58e399eff01';
const BY_HAND = '01a18777-2e7b-7a02-b871-d58e399eff02';
const WORKER_TITLE = 'Review Supplied Immutable Scope';
const BY_HAND_TITLE = 'Count The Files In This Repository';
const FIXTURE = join(__dirname, '..', '.workbench-run-review-worker');

function rollout(thread: string, prompt: string, threadSource: string | null): string {
  const rows: unknown[] = [
    {
      timestamp: '2026-09-20T05:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: thread,
        timestamp: '2026-09-20T05:00:00.000Z',
        cwd: FIXTURE,
        originator: 'codex_exec',
        cli_version: '0.153.4',
        source: 'exec',
        ...(threadSource === null ? {} : { thread_source: threadSource }),
        model_provider: 'openai',
      },
    },
    {
      timestamp: '2026-09-20T05:00:00.500Z',
      type: 'turn_context',
      payload: { cwd: FIXTURE, approval_policy: 'never', model: 'gpt-5.4', reasoning_effort: 'high' },
    },
    {
      timestamp: '2026-09-20T05:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: `${thread}-turn`, model_context_window: 258_400 },
    },
    {
      timestamp: '2026-09-20T05:00:01.100Z',
      type: 'event_msg',
      payload: { type: 'user_message', id: 'person-1', message: prompt, images: [], local_images: [] },
    },
    {
      timestamp: '2026-09-20T05:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' },
    },
    {
      timestamp: '2026-09-20T05:00:02.100Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: `${thread}-turn`, last_agent_message: 'Done.' },
    },
  ];
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function installRollouts(): void {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) throw new Error('CODEX_HOME must name the isolated E2E Codex home');
  const directory = join(codexHome, 'sessions', '2026', '09', '20');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `rollout-2026-09-20T10-00-00-${WORKER}.jsonl`),
    rollout(WORKER, `${WORKER_TITLE}. Return only the requested JSON verdict.`, 'subAgentReview'),
  );
  writeFileSync(
    join(directory, `rollout-2026-09-20T10-05-00-${BY_HAND}.jsonl`),
    rollout(BY_HAND, `${BY_HAND_TITLE}, please.`, 'user'),
  );
}

test('a codex review worker stays out of the sidebar until the agents switch is on', async ({ page, request }) => {
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
      data: { name: 'Review worker fixture', path: FIXTURE, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();

    await page.goto(`/project?id=${project!.id}&tab=chat`);
    const worker = page.locator(`[data-testid="restore-row"][data-external-id="${WORKER}"]`);
    const byHand = page.locator(`[data-testid="restore-row"][data-external-id="${BY_HAND}"]`);
    const toggle = page.getByTestId('toggle-everything');
    await expect(toggle).toHaveAttribute('data-showing-everything', 'false');

    // The person's own `codex exec` run is his chat and is drawn. Waited for
    // first: it is what proves discovery ran at all, so the worker's absence
    // below is an answer rather than an empty list.
    await expect(byHand).toBeVisible({ timeout: 60_000 });
    // Taken before the claim it proves, so a run that goes red leaves the
    // picture of what it saw rather than no picture at all.
    await page.screenshot({ path: 'tests/results/review-worker-hidden.png', fullPage: false });
    await expect(worker).toHaveCount(0);

    // The switch is what the worker's chat is behind, and behind it the chat
    // is still there to be read.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-showing-everything', 'true');
    await expect(worker).toBeVisible({ timeout: 60_000 });
    await expect(byHand).toBeVisible();
    await page.screenshot({ path: 'tests/results/review-worker-shown.png', fullPage: false });

    // And it stays put: the row is not adopted as a chat of his own on the
    // way past, which is how the eight in his own list were kept after the
    // record had already said whose they were.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-showing-everything', 'false');
    await page.reload();
    await expect(byHand).toBeVisible({ timeout: 60_000 });
    await expect(worker).toHaveCount(0);
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
