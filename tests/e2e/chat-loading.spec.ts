import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CHAT = 'bd5664f1-5615-463b-9141-90532e848316';
const ORDINARY = 'bw-1rgs-ordinary-chat';
const TITLE = 'Lot Epics Almost Complete One Two';
const SOURCE = process.env.BEADS_E2E_OWNER_DB;
const RESULT = join(process.cwd(), 'tests', 'results', 'bw-1rgs-chat-loaded.png');

/** Copies only the reported chat into the disposable E2E database. */
function seedExactChat(project: { id: string; path: string }): { eventCount: number; latestText: string } {
  if (!SOURCE) throw new Error('BEADS_E2E_OWNER_DB must name the read-only source workbench.db');
  const source = new DatabaseSync(SOURCE, { readOnly: true });
  const target = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  const session = source.prepare('SELECT * FROM session WHERE id = ?').get(CHAT) as Record<string, unknown> | undefined;
  if (!session) throw new Error(`source database has no chat ${CHAT}`);
  const events = source.prepare('SELECT * FROM event WHERE session_id = ? ORDER BY seq').all(CHAT) as Record<string, unknown>[];

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
      session.created_at, session.last_active_at, session.ended_at, session.imported_at,
      session.imported_recipe, session.last_spoke_at, session.followed_to, session.followed_drawn,
    );
    const put = target.prepare(
      `INSERT INTO event
        (session_id, seq, at, type, json, provider, provider_thread_id, provider_event_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const event of events) {
      put.run(
        event.session_id, event.seq, event.at, event.type, event.json,
        event.provider, event.provider_thread_id, event.provider_event_id,
      );
    }
    target.exec('COMMIT');
  } catch (error) {
    target.exec('ROLLBACK');
    throw error;
  } finally {
    target.close();
    source.close();
  }
  const messages = new Map<string, { text: string; parent: boolean; done: boolean; seq: number }>();
  for (const row of events) {
    const event = JSON.parse(String(row.json)) as Record<string, unknown>;
    const id = typeof event.messageId === 'string' ? event.messageId : '';
    if (!id) continue;
    if (row.type === 'message.started') {
      messages.set(id, { text: '', parent: Boolean(event.parentToolCallId), done: false, seq: Number(row.seq) });
    } else if (row.type === 'text.delta') {
      const message = messages.get(id);
      if (message && typeof event.text === 'string') message.text += event.text;
    } else if (row.type === 'message.completed') {
      const message = messages.get(id);
      if (message) message.done = true;
    }
  }
  const latestText = [...messages.values()]
    .filter((message) => message.done && !message.parent && message.text.trim())
    .sort((left, right) => left.seq - right.seq)
    .at(-1)?.text.trim();
  if (!latestText) throw new Error(`source chat ${CHAT} has no completed parent message`);
  return { eventCount: events.length, latestText };
}

function percentile(samples: number[], percent: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * percent) - 1)]!;
}

function seedOrdinaryChat(project: { id: string; path: string }): void {
  const target = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  const at = '2026-08-29T00:00:00.000Z';
  target.prepare(
    `INSERT INTO session
      (id, brand, project_id, project_path, cwd, permission_mode, title, state,
       origin, created_at, last_active_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(ORDINARY, 'codex', project.id, project.path, project.path, 'default', 'Ordinary paging chat', 'dormant', 'app', at, at);
  const put = target.prepare('INSERT INTO event (session_id, seq, at, type, json) VALUES (?,?,?,?,?)');
  target.exec('BEGIN IMMEDIATE');
  try {
    let seq = 0;
    for (let index = 0; index < 65; index += 1) {
      const event = (body: Record<string, unknown>) => {
        seq += 1;
        const full = { ...body, sessionId: ORDINARY, seq, at };
        put.run(ORDINARY, seq, at, body.type, JSON.stringify(full));
      };
      event({ type: 'message.started', messageId: `ordinary-${index}`, role: index % 2 ? 'assistant' : 'user' });
      event({ type: 'text.delta', messageId: `ordinary-${index}`, text: `ordinary message ${index}` });
      event({ type: 'message.completed', messageId: `ordinary-${index}` });
    }
    target.exec('COMMIT');
  } catch (error) {
    target.exec('ROLLBACK');
    throw error;
  } finally {
    target.close();
  }
}

test('the reported 31,000-plus-event chat opens newest-first and pages only on upward scroll', async ({ page, request }) => {
  test.skip(!SOURCE, 'requires the manager-provided chat database; the test opens it read-only');
  test.setTimeout(120_000);
  const made = await request.post('/api/projects', {
    data: { name: 'Exact blank-chat reproduction', path: process.cwd(), isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string; path: string };
  // It is this active conversation, so the six messages exchanged since the
  // original count legitimately extend it while preserving the reproduction.
  const exact = seedExactChat(project);
  expect(exact.eventCount).toBeGreaterThanOrEqual(31_110);
  // Markdown punctuation is source syntax, not visible text. The assertion is
  // against what the browser actually draws while retaining the source words.
  const latestWords = exact.latestText.replace(/[`*_~]/g, '').replace(/\s+/g, ' ').slice(0, 100);
  seedOrdinaryChat(project);

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  let historyRequests = 0;
  let clickedAt = 0;
  let socketAt = 0;
  let snapshotAt = 0;
  page.on('websocket', (socket) => {
    if (clickedAt > 0) socketAt = performance.now();
    socket.on('framereceived', ({ payload }) => {
    const frame = typeof payload === 'string' ? payload : payload.toString();
    if (clickedAt > 0 && frame.includes('chat.snapshot') && frame.includes(CHAT)) snapshotAt = performance.now();
    });
  });
  await page.route('**/api/workbench/history?*', async (route) => {
    historyRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });

  await page.goto(`/project?id=${project.id}&tab=chat`);
  const row = page.locator(`[data-testid="restore-row"][data-row-key="${CHAT}"]`);
  await expect(row.getByTestId('row-name')).toHaveText(TITLE, { timeout: 30_000 });
  const openedAt = performance.now();
  clickedAt = openedAt;
  await row.getByTestId('row-name').click();

  await expect(page.locator(`[data-testid="chat-tab"][data-session-id="${CHAT}"]`)).toBeVisible();
  await expect(page.getByTestId('chat-loading')).toBeVisible();
  await expect(page.getByTestId('chat-loading')).toBeHidden({ timeout: 60_000 });

  const transcript = page.getByTestId('virtual-transcript');
  await expect(transcript).toHaveAttribute('data-total-items', '40');
  await expect.poll(async () => Number(await transcript.getAttribute('data-mounted-items'))).toBeGreaterThan(0);
  expect(Number(await transcript.getAttribute('data-mounted-items'))).toBeLessThan(40);
  await expect(page.getByTestId('transcript')).toContainText(latestWords);
  const openMs = performance.now() - openedAt;
  console.log(`PERF indexed-cold-chat-open ${openMs.toFixed(1)}ms socket-created ${(socketAt - openedAt).toFixed(1)}ms snapshot-frame ${(snapshotAt - openedAt).toFixed(1)}ms snapshot-to-dom ${(performance.now() - snapshotAt).toFixed(1)}ms`);
  expect(openMs, `chat became usable in ${openMs.toFixed(1)}ms`).toBeLessThan(500);
  await expect.poll(() => page.getByTestId('transcript').evaluate((pane) =>
    Math.abs(pane.scrollHeight - pane.clientHeight - pane.scrollTop),
  )).toBeLessThanOrEqual(2);

  mkdirSync(join(process.cwd(), 'tests', 'results'), { recursive: true });
  await page.screenshot({ path: RESULT, fullPage: false });

  const pane = page.getByTestId('transcript');
  const olderStartedAt = performance.now();
  await pane.evaluate((element) => { element.scrollTop = Math.max(1, Math.floor(element.clientHeight / 2)); });
  await expect(page.getByTestId('older-loading')).toBeVisible();
  const anchor = await page.locator('[data-transcript-key]').evaluateAll((rows) => {
    const pane = document.querySelector('[data-testid="transcript"]')!.getBoundingClientRect();
    const visible = rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > pane.top && rect.top < pane.bottom;
    });
    return visible ? {
      key: visible.getAttribute('data-transcript-key'),
      top: visible.getBoundingClientRect().top,
    } : null;
  });
  expect(anchor).not.toBeNull();

  await expect(transcript).toHaveAttribute('data-total-items', '80');
  const olderMs = performance.now() - olderStartedAt;
  console.log(`PERF older-page-with-200ms-injected-latency ${olderMs.toFixed(1)}ms`);
  expect(olderMs, `older page rendered in ${olderMs.toFixed(1)}ms`).toBeLessThan(400);
  expect(historyRequests).toBe(1);
  await expect.poll(async () => {
    const heldTop = await page.locator(`[data-transcript-key="${anchor!.key}"]`).evaluate((row) => row.getBoundingClientRect().top);
    return Math.abs(heldTop - anchor!.top);
  }).toBeLessThanOrEqual(2);
  expect(Number(await transcript.getAttribute('data-mounted-items'))).toBeLessThan(40);

  // Switching to an ordinary chat replaces the exact chat immediately and
  // opens on that chat's own newest fixed page.
  await page.locator(`[data-testid="restore-row"][data-row-key="${ORDINARY}"]`).getByTestId('row-name').click();
  await expect(page.locator(`[data-testid="chat-tab"][data-session-id="${ORDINARY}"]`)).toBeVisible();
  await expect(page.getByTestId('virtual-transcript')).toHaveAttribute('data-total-items', '40');
  await expect(page.getByTestId('transcript')).toContainText('ordinary message 64');
  await expect(page.getByTestId('transcript')).not.toContainText('CHECKLIST');

  const warm: number[] = [];
  for (let sample = 0; sample < 8; sample += 1) {
    const started = performance.now();
    await row.getByTestId('row-name').click();
    await expect(page.locator(`[data-testid="chat-tab"][data-session-id="${CHAT}"]`)).toBeVisible();
    await expect(page.getByTestId('transcript')).toContainText(latestWords);
    warm.push(performance.now() - started);
    await page.locator(`[data-testid="restore-row"][data-row-key="${ORDINARY}"]`).getByTestId('row-name').click();
    await expect(page.getByTestId('transcript')).toContainText('ordinary message 64');
  }
  const warmP95 = percentile(warm, 0.95);
  const warmP99 = percentile(warm, 0.99);
  console.log(`PERF warm-chat-open p95 ${warmP95.toFixed(1)}ms p99 ${warmP99.toFixed(1)}ms samples ${warm.map((value) => value.toFixed(1)).join(',')}`);
  expect(warmP95, `warm content-correct p95 was ${warmP95.toFixed(1)}ms`).toBeLessThan(150);
  expect(warmP99, `warm content-correct p99 was ${warmP99.toFixed(1)}ms`).toBeLessThan(250);
});
