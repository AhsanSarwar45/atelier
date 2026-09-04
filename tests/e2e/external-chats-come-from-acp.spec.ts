import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * External chats are discovered and replayed over ACP, not by reading each
 * provider's private files.
 *
 * The proof is a chat with no record anywhere on this disk: it exists only
 * because an agent said so on the wire. Everything the sidebar draws about it
 * — its name, its clock, its transcript — has to have come through
 * `session/list` and `session/load`, because there is nothing else to read
 * (bw-t26l.22).
 *
 * Run it against the scripted agent in tests/fixtures/acp-adapters:
 *
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" \
 *     scripts/workbench-e2e.sh tests/e2e/external-chats-come-from-acp.spec.ts
 */
const FIXTURE = join(__dirname, '..', '.workbench-run-acp-external');
const FIRST = {
  id: 'acp-session-one',
  title: 'A chat only ACP knows about',
  asked: 'What did the second page say?',
  answered: 'The first chat answered over ACP.',
};
const SECOND = {
  id: 'acp-session-two',
  title: 'The chat on the second page',
  asked: 'And this one?',
  answered: 'The second chat answered over ACP.',
};

test('external chats are listed and replayed over ACP with no provider record to read', async ({ page, request }) => {
  test.setTimeout(90_000);
  test.skip(
    !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'),
    'needs the scripted ACP agent; see the comment above',
  );
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', {
      data: { name: 'ACP external fixture', path: FIXTURE, isTest: true },
    });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);

    const rowOf = (id: string) => page.locator(`[data-testid="restore-row"][data-external-id="${id}"]`);
    await expect(rowOf(FIRST.id)).toBeVisible({ timeout: 30_000 });
    await expect(rowOf(FIRST.id).getByTestId('row-name')).toHaveText(FIRST.title);
    await expect(rowOf(FIRST.id).locator('span.font-mono').first()).toHaveText('10:00 AM');

    // The second page is only reached by following the cursor the agent
    // handed back. A list that stops at the first page never draws this row.
    await expect(rowOf(SECOND.id)).toBeVisible();
    await expect(rowOf(SECOND.id).getByTestId('row-name')).toHaveText(SECOND.title);

    for (const chat of [FIRST, SECOND]) {
      await rowOf(chat.id).getByTestId('row-name').click();
      await expect(page.getByTestId('user-message').filter({ hasText: chat.asked })).toHaveCount(1);
      await expect(page.getByTestId('assistant-message').filter({ hasText: chat.answered })).toHaveCount(1);
      const other = chat === FIRST ? SECOND : FIRST;
      await expect(page.getByTestId('assistant-message').filter({ hasText: other.answered })).toHaveCount(0);
    }

    // And again: a chat replayed once is this app's own, so the second open
    // does not go back to the agent for it.
    const openedAt = Date.now();
    await rowOf(FIRST.id).getByTestId('row-name').click();
    await expect(page.getByTestId('assistant-message').filter({ hasText: FIRST.answered })).toHaveCount(1);
    expect(Date.now() - openedAt, 'reopening a chat already replayed over ACP').toBeLessThan(500);
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
