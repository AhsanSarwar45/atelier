import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test } from '@playwright/test';

const SOURCE = process.env.BEADS_E2E_OWNER_DB;
const CLAUDE_SOURCE = process.env.BEADS_E2E_OWNER_CLAUDE_CONFIG;
const SHOTS = join(process.cwd(), 'tests', 'results');

test.describe.configure({ mode: 'serial' });

const CHATS = [
  {
    id: 'ec075741-1657-4f67-84cb-728deda54c0d',
    title: 'Need Terminal Integration Will Integrate Default',
    shot: 'claude-history-terminal',
    expectedFirstItems: 40,
    minimumFirstRows: 6,
    hasOlder: true,
    visibleText: ['The teardown is confirmed', 'Closed bw-8jzg.27'],
  },
  {
    id: '021a4ead-5fae-453e-942a-977a13cb6c70',
    title: 'Claude Sidebar Shows Subagents Done Current',
    shot: 'claude-history-sidebar',
    expectedFirstItems: 23,
    minimumFirstRows: 6,
    hasOlder: false,
    visibleText: ['Scout came back with a correction', 'Landed on ours and closed'],
  },
  {
    id: '79225ed8-932b-4ef2-8cda-ff1b883d6381',
    title: 'See Transcript Chat Chat Was Useless',
    shot: 'claude-history-ordered',
    expectedFirstItems: 40,
    minimumFirstRows: 20,
    hasOlder: true,
    visibleText: [] as string[],
  },
] as const;

function copyChat(chat: (typeof CHATS)[number], project: { id: string; path: string }): number {
  if (!SOURCE) throw new Error('BEADS_E2E_OWNER_DB must name the read-only source workbench.db');
  const source = new DatabaseSync(SOURCE, { readOnly: true });
  const target = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  target.exec('PRAGMA busy_timeout = 5000');
  const session = source.prepare('SELECT * FROM session WHERE id = ?').get(chat.id) as Record<string, unknown> | undefined;
  if (!session) throw new Error(`source database has no chat ${chat.id}`);
  const events = source.prepare('SELECT * FROM event WHERE session_id = ? ORDER BY seq').all(chat.id) as Record<string, unknown>[];
  const externalId = typeof session.external_id === 'string' ? session.external_id : null;
  if (CLAUDE_SOURCE && externalId) {
    const projects = join(CLAUDE_SOURCE, 'projects');
    const record = readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projects, entry.name, `${externalId}.jsonl`))
      .find(existsSync);
    if (!record) throw new Error(`Claude source has no record ${externalId}`);
    const isolated = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'copied');
    mkdirSync(isolated, { recursive: true });
    copyFileSync(record, join(isolated, `${externalId}.jsonl`));
    const sourceSession = join(dirname(record), externalId);
    if (existsSync(sourceSession)) {
      cpSync(sourceSession, join(isolated, externalId), { recursive: true });
    }
  }

  target.exec('BEGIN IMMEDIATE');
  try {
    target.prepare(
      `INSERT INTO session
        (id, brand, external_id, project_id, project_path, cwd, model,
         permission_mode, effort, title, state, origin, created_at,
         last_active_at, ended_at, imported_at, imported_recipe,
         last_spoke_at, followed_to, followed_drawn)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      session.id, session.brand, session.external_id, project.id, project.path, project.path,
      session.model, session.permission_mode, session.effort, session.title, 'dormant', session.origin,
      session.created_at, session.last_active_at, session.ended_at, null,
      0, session.last_spoke_at, null, null,
    );
    // Seed no normalized events. Restore must exercise this build's Rust
    // reader against the copied provider record; reusing the owner's already
    // normalized event rows would only prove the pager and could hide a
    // provider-parser regression that reduces a long chat to one message.
    target.exec('COMMIT');
  } catch (error) {
    target.exec('ROLLBACK');
    throw error;
  } finally {
    target.close();
    source.close();
  }
  return events.length;
}

for (const chat of CHATS) {
  test(`${chat.title} loads older history from an upward gesture at the top`, async ({ page, request }) => {
    test.skip(!SOURCE, 'requires the manager-provided chat database; it is opened read-only');
    test.setTimeout(120_000);
    const fixture = join(process.cwd(), 'tests', `.workbench-run-${chat.shot}`);
    rmSync(fixture, { recursive: true, force: true });
    mkdirSync(fixture, { recursive: true });
    const made = await request.post('/api/projects', {
      data: { name: `Claude history reproduction: ${chat.title}`, path: fixture },
    });
    expect(made.status(), await made.text()).toBe(201);
    const project = (await made.json()) as { id: string; path: string };
    expect(copyChat(chat, project)).toBeGreaterThan(100);

    let olderRequests = 0;
    let helperRequests = 0;
    let helperOlderRequests = 0;
    await page.route('**/api/workbench/history?*', async (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (params.has('parent')) {
        helperRequests += 1;
        if (params.has('before')) helperOlderRequests += 1;
      } else if (params.has('before')) olderRequests += 1;
      await route.continue();
    });

    try {
      await page.goto(`/project?id=${project.id}&tab=chat`);
      const row = page.locator(`[data-testid="restore-row"][data-row-key="${chat.id}"]`);
      await expect(row.getByTestId('row-name')).toHaveText(chat.title, { timeout: 30_000 });
      const openedAt = Date.now();
      await row.getByTestId('row-name').click();
      await expect(page.getByTestId('chat-loading')).toBeHidden({ timeout: 60_000 });

      const pane = page.getByTestId('transcript');
      const transcript = page.getByTestId('virtual-transcript');
      await expect.poll(async () => Number(await transcript.getAttribute('data-total-items'))).toBeGreaterThan(0);
      expect(Date.now() - openedAt, `${chat.title}: click-to-usable exceeded one second`).toBeLessThan(1_000);
      await expect(transcript).toHaveAttribute('data-can-load-older', String(chat.hasOlder));
      const firstRows = Number(await transcript.getAttribute('data-total-items'));
      const firstItems = Number(await transcript.getAttribute('data-loaded-items'));
      const firstPrimaryItems = Number(await transcript.getAttribute('data-primary-items'));
      expect(firstPrimaryItems, `${chat.title}: newest main-thread page was incomplete`).toBeGreaterThanOrEqual(
        chat.expectedFirstItems,
      );
      expect(firstRows, `${chat.title}: initial page was only a fragment`).toBeGreaterThanOrEqual(chat.minimumFirstRows);
      for (const words of chat.visibleText) {
        await expect(transcript, `${chat.title}: canonical transcript omitted “${words}”`).toContainText(words);
      }
      // One persisted 40-item page can fan out into more drawn machine rows.
      // It must still remain a small initial render, not the whole transcript.
      expect(firstRows).toBeLessThan(100);
      if (!chat.hasOlder) {
        // This saved chat has exactly 23 main-thread canonical items. Helper
        // turns and six superseded assistant stream/retry rows are not main
        // transcript items. The visible text assertions above prove that the
        // canonical beginning and ending survived normalization.
        // Helper messages have their own independently paged transcript and must not
        // be mixed into this count.
        // page must exhaust its cursor without issuing a pointless older-page
        // request.
        expect(firstPrimaryItems).toBe(chat.expectedFirstItems);
        expect(olderRequests).toBe(0);
        const finished = page.getByTestId('toggle-stopped-agents');
        if (await finished.isVisible()) await finished.click();
        const helperRow = page.locator('[data-testid="sent-away-row"][data-agent="a1a9005b01e0f6a31"]');
        await expect(helperRow).toBeVisible();
        await helperRow.getByTestId('sent-away-open').click();
        const helperPane = page.getByTestId('agent-view-said');
        await expect.poll(() => helperRequests).toBe(1);
        // The complete helper now has later tool calls beyond the old partial
        // import. Its two images are older than the bounded newest page, so
        // reach them through the same independent upward cursor a person uses.
        for (let pageNumber = 0; pageNumber < 10 && await helperPane.locator('img').count() < 2; pageNumber += 1) {
          await expect(helperPane).toHaveAttribute('data-can-load-older', 'true');
          const requestsBefore = helperOlderRequests;
          await helperPane.evaluate((element) => {
            element.scrollTop = 0;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
          await expect.poll(() => helperOlderRequests - requestsBefore).toBe(1);
        }
        await expect(helperPane.locator('img')).toHaveCount(2);
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `${chat.shot}-after.png`) });
        return;
      }
      const requestsBeforeGesture = olderRequests;
      await pane.evaluate((element) => {
        (window as typeof window & { __olderWheel?: number }).__olderWheel = 0;
        element.addEventListener('wheel', () => {
          const observed = window as typeof window & { __olderWheel?: number };
          observed.__olderWheel = (observed.__olderWheel ?? 0) + 1;
        }, { once: true });
        // Park just outside the load threshold. Jumping straight to zero is
        // itself an upward-scroll request; following it with a wheel would be
        // two intents while the assertion below deliberately proves one.
        element.scrollTop = element.clientHeight + 8;
      });
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${chat.shot}-before.png`) });
      await pane.hover();
      await page.mouse.wheel(0, -1200);
      await expect.poll(() => page.evaluate(() => (window as typeof window & { __olderWheel?: number }).__olderWheel ?? 0), {
        message: `${chat.title}: the browser did not deliver the upward wheel to the transcript pane`,
      }).toBe(1);
      await expect.poll(
        () => olderRequests - requestsBeforeGesture,
        { message: `${chat.title}: the upward gesture asked for no older history` },
      ).toBe(1);
      // Older parent rows can fold formerly orphaned machine rows, so the
      // drawn count can grow, shrink, or remain equal. The provider-neutral
      // transcript-item window itself must grow.
      await expect.poll(async () => Number(await transcript.getAttribute('data-loaded-items'))).toBeGreaterThan(firstItems);
      await page.waitForTimeout(100); // let the prepend anchor finish its measured correction

      // This real record currently contains only 44 visible canonical items:
      // the newest forty and one four-item older page. If a future fixture has
      // another cursor, prove the next gesture consumes it too; exhaustion is
      // otherwise the correct result, not evidence of a one-shot scroll latch.
      if (await transcript.getAttribute('data-can-load-older') === 'true') {
        const requestsBeforeSecondGesture = olderRequests;
        await pane.evaluate((element) => { element.scrollTop = 0; });
        await pane.hover();
        await page.mouse.wheel(0, -1200);
        await expect.poll(
          () => olderRequests - requestsBeforeSecondGesture,
          { message: `${chat.title}: history stopped while another cursor existed` },
        ).toBe(1);
      }

      if (chat.id === '79225ed8-932b-4ef2-8cda-ff1b883d6381') {
        // This saved helper owns 934 canonical events. Its transcript has an
        // independent cursor: main-chat exhaustion must not make those words
        // unreachable, and the provider that produced them is irrelevant.
        const finished = page.getByTestId('toggle-stopped-agents');
        if (await finished.isVisible()) await finished.click();
        const helperRow = page.locator('[data-testid="sent-away-row"][data-agent="a0e4a338553d6007d"]');
        await expect(helperRow).toBeVisible();
        const helperOpenedAt = performance.now();
        await helperRow.getByTestId('sent-away-open').click();
        const helperPane = page.getByTestId('agent-view-said');
        await expect.poll(() => helperRequests).toBe(1);
        await expect(helperPane).toHaveAttribute('data-can-load-older', 'true');
        expect(performance.now() - helperOpenedAt, 'helper newest page was not subsecond').toBeLessThan(500);
        const firstHelperItems = Number(await page.getByTestId('agent-view').getAttribute('data-said'));
        expect(firstHelperItems).toBe(40);
        const newestHelperText = (await helperPane.innerText()).trim();
        expect(newestHelperText.length).toBeGreaterThan(0);
        const helperOlderAt = performance.now();
        await helperPane.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await expect.poll(() => helperOlderRequests).toBe(1);
        await expect.poll(async () => Number(await page.getByTestId('agent-view').getAttribute('data-said'))).toBeGreaterThan(firstHelperItems);
        expect(performance.now() - helperOlderAt, 'helper older page was not subsecond').toBeLessThan(500);
        expect((await helperPane.innerText()).trim()).toContain(newestHelperText);
      }
      await page.screenshot({ path: join(SHOTS, `${chat.shot}-after.png`) });
    } finally {
      await request.delete(`/api/projects/${project.id}`);
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
