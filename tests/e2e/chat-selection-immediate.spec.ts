import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { test as base, expect, chromium } from '@playwright/test';

const test = base.extend({ browser: [async ({}, use) => {
  const browser = process.env.CDP_URL
    ? await chromium.connectOverCDP(process.env.CDP_URL)
    : await chromium.launch();
  await use(browser);
  if (!process.env.CDP_URL) await browser.close();
}, { scope: 'worker' }] });

const ids = ['instant-chat-a', 'instant-chat-b'];
test('chat selection does not wait for navigation and a cached chat needs no response', async ({ page, request }, testInfo) => {
  test.setTimeout(90000);
  const fixture = join(process.cwd(), 'tests/.workbench-run-instant');
  mkdirSync(fixture, { recursive: true });
  const response = await request.post('/api/projects', { data: { name: 'Chat switch timing', path: fixture } });
  expect(response.status()).toBe(201);
  const project = await response.json();
  const db = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const at = '2026-10-27T09:00:00Z';
  for (const id of ids) {
    db.prepare(`INSERT INTO session (id, brand, project_id, project_path, cwd, permission_mode, title, state, origin, created_at, last_active_at, last_spoke_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, 'claude', project.id, fixture, fixture, 'default', id, 'dormant', 'app', at, at, at);
    const put = db.prepare('INSERT INTO event (session_id,seq,at,type,json) VALUES (?,?,?,?,?)');
    db.exec('BEGIN');
    for (let n = 0; n < 1000; n++) {
      const events = [
        { type: 'message.started', messageId: `${id}-${n}`, role: n % 2 ? 'assistant' : 'user' },
        { type: 'text.delta', messageId: `${id}-${n}`, text: `${id} message ${n}` },
        { type: 'message.completed', messageId: `${id}-${n}` },
      ];
      events.forEach((event, i) => {
        const seq = n * 3 + i + 1;
        put.run(id, seq, at, event.type, JSON.stringify({ ...event, seq, at, sessionId: id }));
      });
    }
    db.exec('COMMIT');
  }
  db.close();
  try {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const snapshots: { id: string; bytes: number; items: number }[] = [];
    await page.routeWebSocket(/.*/, socket => {
      const server = socket.connectToServer();
      server.onMessage(message => {
        const decoded = typeof message === 'string' ? message : gunzipSync(message).toString();
        const frame = JSON.parse(decoded);
        if (frame.tag === 'chat.snapshot') {
          const view = JSON.parse(frame.data);
          snapshots.push({ id: frame.scope, bytes: Buffer.byteLength(decoded), items: view.items.length });
          // Hold each chat's history while checking the selected shell.
          setTimeout(() => socket.send(message), 1000);
        } else socket.send(message);
      });
    });
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row = (id: string) => page.locator(`[data-testid="restore-row"][data-row-key="${id}"] [data-testid="row-name"]`);
    await expect(row(ids[0])).toBeVisible({ timeout: 30000 });
    const requests: string[] = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/project.txt' || url.searchParams.has('_rsc')) {
        requests.push(url.pathname);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      await route.continue();
    });
    for (const id of ids) {
      const start = Date.now();
      await row(id).click({ noWaitAfter: true });
      await expect(page.getByTestId('chat-tab')).toHaveAttribute('data-session-id', id, { timeout: 250 });
      await expect(page.getByTestId('chat-loading')).toBeVisible();
      console.log('SHELL', id, Date.now() - start);
      await page.screenshot({ path: testInfo.outputPath(`instant-${id}.png`) });
      const selected = await page.getByTestId('chat-tab').getAttribute('data-session-id');
      console.log('SELECTION', id, Date.now() - start, selected, requests);
      expect(selected, 'the selected shell must change before navigation finishes').toBe(id);
      await expect(page.getByTestId('transcript')).toContainText(`${id} message 999`);
      await expect(page.getByTestId('virtual-transcript')).toHaveAttribute('data-total-items', '40');
    }
    expect(requests).toEqual([]);
    expect(snapshots.map(snapshot => snapshot.id)).toEqual(ids);
    for (const snapshot of snapshots) {
      expect(snapshot.items).toBe(40);
      expect(snapshot.bytes).toBeLessThan(30_000);
    }
    console.log('SNAPSHOTS', snapshots);
    await page.context().setOffline(true);
    const start = Date.now();
    await row(ids[0]).click({ noWaitAfter: true });
    await expect(page.getByTestId('transcript')).toContainText(`${ids[0]} message 999`, { timeout: 250 });
    console.log('WARM', Date.now() - start);
    await expect(page.getByTestId('chat-loading')).toHaveCount(0);
    await page.goBack();
    await expect(page.getByTestId('transcript')).toContainText(`${ids[1]} message 999`);
    await page.context().setOffline(false);
    await page.reload();
    await expect(page.getByTestId('transcript')).toContainText(`${ids[1]} message 999`);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
