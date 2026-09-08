/**
 * An edit whose arguments contain most of a file should say how large it was
 * without printing a wall of partial code into the conversation (bw-2xjd.1).
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

const CHAT = 'large-edit-card-fixture';

test('a large edit says how much it hides instead of showing partial code', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 720 });
  const run = join(process.cwd(), 'tests', '.workbench-run-large-edit-card');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const edited = join(projectPath, 'src', 'generated.ts');
  const before = `${'const before = 1;\n'.repeat(240).slice(0, 4000)}\n… and 5539 more characters`;
  const after = `${'const after = 2;\n'.repeat(240).slice(0, 4000)}\n… and 4310 more characters`;

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'codex', externalId: 'fixture', model: 'gpt-5', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'tool.started', toolCallId: 'edit', name: 'Edit', input: { file_path: edited }, title: `Changed ${edited}`, parentToolCallId: null },
    { ...base, seq: 3, type: 'diff', toolCallId: 'edit', path: edited, before, after, line: 1 },
    { ...base, seq: 4, type: 'tool.completed', toolCallId: 'edit', ok: true, output: 'The file has been updated.' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const snapshot = foldAll(events);

  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
        })), 0);
      }
      close() { this.readyState = FixtureSocket.CLOSED; }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, view: snapshot });
  await page.route('**/api/fs/exists?*', (route) => route.fulfill({ json: { exists: true } }));
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'codex', title: 'Large edit card', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Large edit card', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Large edit card', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Large edit card' }).getByTestId('row-name').click();

    const row = page.getByTestId('tool-row').first();
    await expect(row).toHaveAttribute('data-open', 'true', { timeout: 60_000 });
    const summary = page.getByTestId('diff-summary');
    await expect(summary).toContainText('9,539 characters hidden');
    await expect(summary).toContainText('8,310 characters hidden');
    await expect(page.getByTestId('diff-table')).toHaveCount(0);
    await expect(row).not.toContainText('const before');
    await expect(row).not.toContainText('const after');
    await page.screenshot({ path: 'tests/results/bw-2xjd-after.png', fullPage: false });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
