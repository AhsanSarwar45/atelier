import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { aProjectOfItsOwn, claimConversation, openChatTab, recordDir } from './fixture-held';

/**
 * A command's clock is the command's, not the page's (bw-iavgo.1).
 *
 * A chat a terminal is working in, three minutes into a `sleep 600`, used to
 * say a few seconds on the working line after a reload, because the count
 * started from the moment the page opened rather than the moment the call
 * began. And a finished call said nothing about how long it took. Both are
 * read off the record's own dates here, so both must read the same before and
 * after the page is redrawn.
 *
 * Two ways the calls reach the screen, because they are dated by different
 * code: written while the chat is open (the follower reads the new lines), and
 * already in the record when the chat is first opened (the import).
 *
 * Needs the shared marker harness; see fixture-held.ts for BEADS_E2E_MARKERS.
 * Run: scripts/workbench-e2e.sh tests/e2e/a-command-keeps-its-clock-across-a-reload.spec.ts
 */

const SHOTS = 'tests/results/iavgo-after';

/** A record whose lines carry the dates a terminal would have written. */
function aRecord(projectPath: string) {
  const id = randomUUID();
  const dir = recordDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  let parent: string | null = null;
  const line = (role: 'user' | 'assistant', content: unknown, at: number, extra: Record<string, unknown> = {}) => {
    const uuid = randomUUID();
    const row = JSON.stringify({
      parentUuid: parent,
      isSidechain: false,
      type: role,
      message: role === 'user' ? { role, content } : { role, model: 'claude-opus-5', content },
      uuid,
      timestamp: new Date(at).toISOString(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: projectPath,
      sessionId: id,
      version: '2.1.232',
      ...extra,
    });
    parent = uuid;
    return row;
  };
  const now = Date.now();
  writeFileSync(file, line('user', 'Build it, then wait on the deploy', now - 6 * 60_000) + '\n');
  return {
    id,
    file,
    /** A build that began five minutes ago and answered 45 s later; then a `sleep 600` begun three minutes ago. */
    worksOn(): void {
      const t1 = now - 5 * 60_000;
      const rows = [
        line('assistant', [{ type: 'tool_use', id: `toolu_done_${id.slice(0, 8)}`, name: 'Bash', input: { command: 'npm run build' } }], t1),
        line('user', [{ type: 'tool_result', tool_use_id: `toolu_done_${id.slice(0, 8)}`, content: 'built' }], t1 + 45_000, {
          toolUseResult: { stdout: 'built', stderr: '', interrupted: false, isImage: false },
        }),
        line('assistant', [{ type: 'tool_use', id: `toolu_run_${id.slice(0, 8)}`, name: 'Bash', input: { command: 'sleep 600' } }], now - 3 * 60_000),
      ];
      appendFileSync(file, rows.join('\n') + '\n');
    },
  };
}

interface Seen {
  workingElapsed: string | null;
  toolElapsed: string | null;
  toolTook: string | null;
}

async function read(page: Page): Promise<Seen> {
  const text = async (sel: string) => {
    const l = page.locator(sel).first();
    return (await l.count()) ? ((await l.textContent()) ?? '').trim() : null;
  };
  return {
    workingElapsed: await text('[data-testid="working-elapsed"]'),
    toolElapsed: await text('[data-testid="tool-row"][data-tool-status="running"] [data-testid="tool-elapsed"]'),
    toolTook: await text('[data-testid="tool-row"][data-tool-status="ok"] [data-testid="tool-took"]'),
  };
}

async function scenario(
  page: Page,
  request: APIRequestContext,
  what: 'followed' | 'imported',
  shot: (when: 'open' | 'reload') => string,
) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const project = await aProjectOfItsOwn(request, `clock-${what}`);
  const chat = aRecord(project.path);
  if (what === 'imported') chat.worksOn();
  const release = claimConversation(chat.id, { status: 'busy' });
  const row = page.locator(`[data-testid="restore-row"][data-external-id="${chat.id}"]`);
  const running = page.locator('[data-testid="tool-row"][data-tool-name="Bash"][data-tool-status="running"]');
  const finished = page.locator('[data-testid="tool-row"][data-tool-name="Bash"][data-tool-status="ok"]');

  const settle = async () => {
    await expect(running).toHaveCount(1, { timeout: 30_000 }).catch(() => {});
    await expect(finished).toHaveCount(1, { timeout: 10_000 }).catch(() => {});
    await page.getByTestId('working-line').waitFor({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
  };
  const shoot = async (path: string) => {
    const tab = page.getByTestId('chat-tab');
    if (await tab.count()) await tab.screenshot({ path, animations: 'disabled' });
    else await page.screenshot({ path });
  };

  try {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
    await openChatTab(page, project);
    await expect(row, 'the chat being worked in was not offered').toBeVisible({ timeout: 30_000 });
    await row.getByTestId('row-name').click();
    await expect(page.getByTestId('transcript').getByText('Build it, then wait on the deploy')).toBeVisible({
      timeout: 30_000,
    });
    // The terminal goes on working while the chat is on the screen.
    if (what === 'followed') chat.worksOn();
    await settle();
    await shoot(shot('open'));
    const before = await read(page);
    console.log(`[iavgo ${what}] after open:`, JSON.stringify(before));

    await page.reload();
    // Reopen it if the reload did not bring the chat back on its own.
    const back = page.getByTestId('transcript').getByText('Build it, then wait on the deploy');
    if (!(await back.isVisible({ timeout: 15_000 }).catch(() => false))) {
      await row.waitFor({ timeout: 60_000 });
      await row.getByTestId('row-name').click();
    }
    await settle();
    await shoot(shot('reload'));
    const after = await read(page);
    console.log(`[iavgo ${what}] after reload:`, JSON.stringify(after));

    for (const [when, seen] of [['open', before], ['reload', after]] as const) {
      // Read in whole, the record's unanswered call stays running while a
      // process holds the chat; it was closed as failed (bw-iavgo.2).
      expect.soft(seen.workingElapsed, `working-elapsed after ${when}`).toMatch(/^[23]m/);
      expect.soft(seen.toolElapsed, `running tool-elapsed after ${when}`).toMatch(/^[23]m/);
      expect.soft(seen.toolTook, `finished tool-took after ${when}`).toBe('45s');
    }
  } finally {
    release();
    rmSync(chat.file, { force: true });
    await project.remove();
  }
}

test('commands written while the chat is open keep their times across a reload', async ({ page, request }) => {
  test.setTimeout(240_000);
  await scenario(page, request, 'followed', (when) => `${SHOTS}-${when}.png`);
});

test('commands already in the record when the chat is opened keep their times across a reload', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await scenario(page, request, 'imported', (when) => `${SHOTS}-${when}-imported.png`);
});
