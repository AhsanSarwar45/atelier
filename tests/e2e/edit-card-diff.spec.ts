/**
 * An edit's diff is inside its card, and the card can be shut on it.
 *
 * The unit tests know the row's own markup; this is the screen. What it proves
 * is what the reader sees: the chat opens with the changed lines already
 * drawn, one click on the row's line puts them away, and nothing of the diff
 * is left hanging under the card (bw-cso1.1).
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

const CHAT = 'edit-card-diff-fixture';

test('the edit card opens on its diff and shuts on it', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 720 });
  const run = join(process.cwd(), 'tests', '.workbench-run-edit-card');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const edited = join(projectPath, 'src', 'wheels.ts');
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  const before = ['export function wheels(n: number) {', '  return n * 2;', '}', ''].join('\n');
  const after = ['export function wheels(n: number) {', '  if (n < 0) return 0;', '  return n * 4;', '}', ''].join('\n');
  writeFileSync(edited, after);

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'codex', externalId: 'fixture', model: 'gpt-5', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'tool.started', toolCallId: 'edit', name: 'Edit', input: { file_path: edited }, title: `Changed ${edited}`, parentToolCallId: null },
    { ...base, seq: 3, type: 'diff', toolCallId: 'edit', path: edited, before, after, line: 2 },
    { ...base, seq: 4, type: 'tool.completed', toolCallId: 'edit', ok: true, output: 'The file has been updated.' },
    { ...base, seq: 5, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 6, type: 'text.delta', messageId: 'answer', text: 'Doubled becomes quadrupled, and a negative count is refused.' },
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
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'codex', title: 'Edit card diff', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Edit card diff', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Edit card diff', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Edit card diff' }).getByTestId('row-name').click();

    const row = page.getByTestId('tool-row').first();
    const diff = page.getByTestId('diff-view');
    // Nobody clicked: the change is already on the screen.
    await expect(row).toHaveAttribute('data-open', 'true', { timeout: 60_000 });
    await expect(diff).toBeVisible();
    // And it is the card's own body, not something drawn beneath it.
    await expect(row.getByTestId('tool-toggle').locator('..').getByTestId('diff-view')).toBeVisible();
    // The edit says the change once: no arguments, no printed sentence.
    await expect(page.getByTestId('tool-input')).toHaveCount(0);
    await expect(page.getByTestId('tool-output')).toHaveCount(0);
    await page.screenshot({ path: 'tests/results/edit-card-open.png', fullPage: false });

    await row.getByTestId('tool-toggle').click();
    await expect(row).toHaveAttribute('data-open', 'false');
    await expect(diff).toHaveCount(0);
    // The chevron turns back over about a sixth of a second; a shot taken the
    // instant the diff goes catches it halfway round.
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'tests/results/edit-card-shut.png', fullPage: false });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
