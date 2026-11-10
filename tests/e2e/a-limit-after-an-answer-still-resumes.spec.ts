/**
 * A chat that said something, worked, and then ran into its usage limit is
 * still a chat held by that limit, and is planned a resume (bw-b8t8n).
 *
 * The kit says its limit in the agent's own voice, as an answer of its own:
 * "You've hit your session limit · resets 3:20pm (Asia/Karachi)". A turn made
 * of nothing else was read as refused. A turn that first said "Finding it.",
 * ran a tool, and only then hit the limit was read whole — both answers joined
 * — and passed for an ordinary answer: no usage-limit notice was written, so
 * the auto-resume watcher had nothing to plan, said nothing, and never sent
 * the chat on. Only the turn's last answer is now read.
 *
 * The scripted agent plays exactly that turn when
 * BEADS_E2E_ACP_LIMIT_AFTER_ANSWER=1, with a reset three hours ahead so the
 * watcher announces a resume rather than performing one.
 *
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" BEADS_E2E_ACP_LIMIT_AFTER_ANSWER=1 \
 *     scripts/workbench-e2e.sh tests/e2e/a-limit-after-an-answer-still-resumes.spec.ts
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-limit-after-answer');
const SHOTS = join(process.cwd(), 'tests', 'results');

test('a limit hit after the chat has spoken still plans its resume', async ({ page, request }) => {
  test.setTimeout(240_000);
  test.skip(
    !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters') ||
      process.env.BEADS_E2E_ACP_LIMIT_AFTER_ANSWER !== '1',
    'needs the scripted ACP agent in its limit-after-answer mode; see the comment above',
  );
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  let project: Project | undefined;
  try {
    const on = await request.put('/api/settings/limits', { data: { autoResume: true } });
    expect(on.ok(), await on.text()).toBe(true);

    const made = await request.post('/api/projects', {
      data: { name: 'limit after answer fixture', path: ROOT, isTest: true },
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

    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
    await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });

    const sent = await request.post('/api/workbench/command', {
      data: { type: 'prompt.send', sessionId, text: 'Find where the limit is read.' },
    });
    expect(sent.ok(), await sent.text()).toBe(true);

    // The turn spoke first, so it is not a bare refusal.
    await expect(page.getByTestId('assistant-message').filter({ hasText: 'Finding it.' })).toHaveCount(1, {
      timeout: 60_000,
    });

    // The limit stands...
    const limit = page.locator('[data-testid="note-row"][data-note-kind="provider/usage_limit"]');
    await expect(limit.first()).toBeVisible({ timeout: 60_000 });
    await expect(limit.first()).toContainText('(Asia/Karachi)');

    // ...and the watcher, which reads standing limits every fifteen seconds,
    // says when it will send the chat on.
    await expect(page.getByText(/^Auto-resume at /)).toBeVisible({ timeout: 60_000 });

    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'bw-b8t8n-limit-after-answer-resumes.png') });
  } finally {
    await request.put('/api/settings/limits', { data: { autoResume: false } });
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(ROOT, { recursive: true, force: true });
  }
});
