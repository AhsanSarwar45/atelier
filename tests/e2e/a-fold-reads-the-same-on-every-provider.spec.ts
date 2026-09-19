/**
 * A chat folding itself up says so the same way, whoever is driving it
 * (bw-ryh3).
 *
 * The manager's screenshot: an answer ending "Let me follow the existing spec's
 * shape." with "Compacting...Compacting...Compacting..." run straight on to the
 * end of it, eight more after that, and "Compacting completed." below. Those
 * are not the agent's words. ACP's compaction kinds are unstable, so the
 * adapter shipped for Claude has nowhere to put a fold and says it in the
 * agent's own voice, a beat every thirty seconds — and every one of those beats
 * was appended to whatever message happened to be open.
 *
 * One event had three readings: prose on Claude, an "unrecognized update" note
 * on Codex, whose adapter sends ACP's real `compaction_update`, and the actual
 * word, mark and measured bar only for a chat somebody ELSE held.
 *
 * Both adapter shapes are scripted, and this case holds them to the same
 * screen: the word Summarising, the bar that only this state gets, and an
 * answer whose sentences are exactly the two the agent wrote.
 *
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" \
 *     scripts/workbench-e2e.sh tests/e2e/a-fold-reads-the-same-on-every-provider.spec.ts
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-fold');
const SHOTS = 'tests/results';

/** The sentence the fold must not land in the middle of. */
const BEFORE = 'Let me follow the existing spec’s shape.';
/** What the agent says once the fold is over. */
const AFTER = 'Now a test to hold it.';

/**
 * The two adapters in the wild, and what each one actually sends.
 *
 * `claude` is the shipped adapter's stand-in prose; `codex` is ACP's own
 * compaction_update. The screen may not be able to tell them apart.
 */
const SHAPES = [
  { brand: 'claude', asked: 'fold this up the old way', says: 'its own prose' },
  { brand: 'codex', asked: 'fold this up', says: 'ACP compaction_update' },
] as const;

for (const shape of SHAPES) {
  test(`a fold said as ${shape.says} draws the one standing and no words`, async ({ page, request }) => {
    test.setTimeout(180_000);
    test.skip(
      !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'),
      'needs the scripted ACP agent; see the comment above',
    );
    const root = `${ROOT}-${shape.brand}`;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });

    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });

    let project: Project | undefined;
    try {
      const made = await request.post('/api/projects', {
        data: { name: `fold fixture ${shape.brand}`, path: root, isTest: true },
      });
      expect(made.status(), await made.text()).toBe(201);
      project = (await made.json()) as Project;

      const started = await request.post('/api/workbench/command', {
        data: {
          type: 'session.start',
          projectId: project.id,
          projectPath: project.path,
          brand: shape.brand,
          permissionMode: 'bypassPermissions',
        },
      });
      expect(started.ok(), await started.text()).toBe(true);
      const sessionId = ((await started.json()) as { id: string }).id;

      await page.setViewportSize({ width: 1100, height: 720 });
      await page.goto(`/project?id=${project.id}&tab=chat&chat=${sessionId}`);
      await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });

      const sent = await request.post('/api/workbench/command', {
        data: { type: 'prompt.send', sessionId, text: shape.asked },
      });
      expect(sent.ok(), await sent.text()).toBe(true);

      // The agent's sentence lands, and then the fold begins.
      await expect(page.getByTestId('assistant-message').filter({ hasText: BEFORE }))
        .toHaveCount(1, { timeout: 60_000 });

      // Mid-fold: the one word, and the bar that only this state gets.
      const line = page.getByTestId('working-line');
      await expect(line).toContainText('Summarising', { timeout: 30_000 });
      await expect(line).toHaveAttribute('data-waiting', 'false');
      await expect(page.getByTestId('summarising-bar')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/a-fold-mid-${shape.brand}.png` });

      // Not one beat of the adapter's own reached the conversation.
      const said = page.getByTestId('assistant-message');
      await expect(said.filter({ hasText: 'Compacting' })).toHaveCount(0);

      // Over. The answer carries on, and its sentences are exactly the two the
      // agent wrote — the fold left no mark inside either of them.
      await expect(said.filter({ hasText: AFTER })).toHaveCount(1, { timeout: 60_000 });
      await expect(page.getByTestId('summarising-bar')).toHaveCount(0);
      await expect(said.filter({ hasText: 'Compacting' })).toHaveCount(0);
      const whole = (await said.first().innerText()).replace(/\s+/g, ' ').trim();
      expect(whole).toBe(`${BEFORE} ${AFTER}`);
      await page.screenshot({ path: `${SHOTS}/a-fold-done-${shape.brand}.png` });
    } finally {
      if (project) await request.delete(`/api/projects/${project.id}`);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
