/**
 * A question the reader has answered stops claiming it is still waiting for
 * them (bw-qrgl.1).
 *
 * The manager answered a question card, watched the card flip to "Answered",
 * and watched the amber line an inch below it go on counting: "after i click
 * submit, it says this, still waiting. doesn't seem like it pushes the result
 * to acp". It did push it — the answer resolves the pending elicitation inside
 * fifty milliseconds — but the elicitation path wrote no state of its own when
 * it resolved, the way the permission path does, so `waiting_permission` stood
 * until the agent's next update happened to carry a new one. An agent that
 * goes away and thinks does not send one for minutes, and for all of those
 * minutes the screen said the answer had not been given.
 *
 * The scripted agent asks and then goes quiet, which is the only shape that
 * can tell the two builds apart: one that speaks the instant it is answered
 * clears the line either way.
 *
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" \
 *     scripts/workbench-e2e.sh tests/e2e/an-answered-question-stops-saying-it-is-waiting.spec.ts
 *
 * The other half of the pair is the same case against the build before the
 * fix — THE_ANSWERED_LINE_LINGERS=1 says which picture is being taken and what
 * the screen is expected to say.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-answered-question');
const SHOTS = 'tests/results';
/** The question the scripted agent asks, drawn from its schema. */
const HEADER = 'Direction';
const CHOSEN = 'Prompt for the passphrase in the UI';
/** The build that left the line standing, which is the picture of the complaint. */
const LINGERS = Boolean(process.env.THE_ANSWERED_LINE_LINGERS);

test('the waiting line goes when the answer is given, not when the agent next speaks', async ({ page, request }) => {
  test.setTimeout(180_000);
  test.skip(
    !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'),
    'needs the scripted ACP agent; see the comment above',
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
    const made = await request.post('/api/projects', {
      data: { name: 'answered question fixture', path: ROOT, isTest: true },
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
      data: { type: 'prompt.send', sessionId, text: 'Ask me which direction to take.' },
    });
    expect(sent.ok(), await sent.text()).toBe(true);

    // Asked. The line says so, in the one state where the screen is asking
    // rather than telling.
    const card = page.getByTestId('question-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText(HEADER);
    const line = page.getByTestId('working-line');
    await expect(line).toHaveAttribute('data-waiting', 'true');
    await expect(line).toContainText('Waiting for you');

    await card.getByLabel(CHOSEN).click();
    await card.getByRole('button', { name: 'Answer' }).click();

    // Answered, and the agent has said nothing since — it is away working, the
    // way a real one is. This is the window the complaint lives in.
    await expect(card).toHaveAttribute('data-question-state', 'resolved', { timeout: 30_000 });
    await expect(page.getByTestId('assistant-message').filter({ hasText: 'the reader answered' })).toHaveCount(0);

    if (LINGERS) {
      // The build before the fix: the card says answered and the line, an inch
      // below it, still says the reader has not answered.
      await expect(line).toHaveAttribute('data-waiting', 'true');
      await expect(line).toContainText('Waiting for you');
    } else {
      await expect(line).toHaveAttribute('data-waiting', 'false', { timeout: 15_000 });
      await expect(line).not.toContainText('Waiting for you');
      await expect(line).toContainText('Working');
    }
    await page.screenshot({
      path: `${SHOTS}/an-answered-question-${LINGERS ? 'lingers' : 'stops-waiting'}.png`,
    });

    // And when the agent does come back, it has the answer that was given.
    await expect(page.getByTestId('assistant-message').filter({ hasText: `answered the question with ${CHOSEN}` }))
      .toHaveCount(1, { timeout: 90_000 });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(ROOT, { recursive: true, force: true });
  }
});
