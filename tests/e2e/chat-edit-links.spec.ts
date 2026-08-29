import { expect, test } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { makeFixtureProject } from './fixture-board';

const CHAT = 'chat-edit-links-fixture';

test('edit paths open in the editor at the first changed line', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 720 });
  const run = join(process.cwd(), 'tests', '.workbench-run-edit-links');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const edited = join(projectPath, 'src', 'sessions.ts');
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  writeFileSync(edited, Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n'));

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'codex', externalId: 'fixture', model: 'gpt-5', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'tool.started', toolCallId: 'edit', name: 'Edit', input: { file_path: edited }, title: `Changed ${edited}`, parentToolCallId: null },
    { ...base, seq: 3, type: 'diff', toolCallId: 'edit', path: edited, before: 'line 72\nline 73', after: 'line 72\nchanged line 73', line: 73 },
    { ...base, seq: 4, type: 'tool.completed', toolCallId: 'edit', ok: true, output: 'Done' },
    { ...base, seq: 5, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 6, type: 'text.delta', messageId: 'answer', text: `Updated ${edited}.` },
    { ...base, seq: 7, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 8, type: 'session.state', state: 'idle', label: 'Ready' },
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
  const opened: Array<{ path: string; target: string; line?: number }> = [];
  await page.route('**/api/fs/open-external', async (route) => {
    opened.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({ json: { success: true } });
  });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'codex', title: 'Clickable edit links', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Clickable edit links', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Clickable edit links', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Clickable edit links' }).getByTestId('row-name').click();

    const rowLink = page.locator('[data-testid="tool-toggle"] [data-path-target="editor"]').first();
    await expect(rowLink).toHaveAttribute('data-path-line', '73', { timeout: 60_000 });
    await expect(page.locator('[data-testid="diff-view"] [data-path-target="editor"]')).toHaveAttribute('data-path-line', '73', { timeout: 60_000 });
    await rowLink.click();
    await expect.poll(() => opened).toEqual([{ path: edited, target: 'vscode', line: 73 }]);
    await page.screenshot({ path: 'tests/results/chat-edit-links-after.png', fullPage: false });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(run, { recursive: true, force: true });
  }
});
