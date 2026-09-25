/**
 * A tool call's line in a chat is as tall as its words on a phone.
 *
 * The owner's report, off a phone: "command boxes in chats are now taller on
 * mobile. i want them back in previous height" (bw-4cqv). The line that heads
 * each tool's box became the library's Row, and a Row is a `<button>`, so the
 * touch screen's 44px floor landed on it; the Button it replaced was
 * `size="inherit"`, which turns that floor off. The box already reaches the
 * thumb through the row's invisible 44px band (`data-reach="row"`), so the
 * floor only made every box taller.
 *
 * What is checked is the drawn line: shorter than the floor, with the band
 * still there to press.
 *
 *   scripts/workbench-e2e.sh tests/e2e/a-tool-row-keeps-its-height-on-a-phone.spec.ts
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

const CHAT = 'tool-row-height-fixture';
const TAP = 44;

// `pointer: coarse` is what switches the floor on; a phone-sized window driven
// by a mouse shows none of it.
test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

test('a tool call and a thought stay their own height on a phone', async ({ page, request }) => {
  test.setTimeout(90_000);
  const run = join(process.cwd(), 'tests', '.workbench-run-tool-row-height');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'codex', externalId: 'fixture', model: 'gpt-5', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'think', role: 'assistant' },
    { ...base, seq: 3, type: 'thinking.delta', messageId: 'think', text: 'Which files hold the wheel count?' },
    { ...base, seq: 4, type: 'message.completed', messageId: 'think' },
    { ...base, seq: 5, type: 'tool.started', toolCallId: 'ls', name: 'Bash', input: { command: 'git worktree list' }, title: 'Listed the worktrees', parentToolCallId: null },
    { ...base, seq: 6, type: 'tool.completed', toolCallId: 'ls', ok: false, output: 'fatal: not a repository' },
    { ...base, seq: 7, type: 'tool.started', toolCallId: 'grep', name: 'Grep', input: { pattern: 'wheels' }, title: 'Searched for wheels', parentToolCallId: null },
    { ...base, seq: 8, type: 'tool.completed', toolCallId: 'grep', ok: true, output: 'src/wheels.ts' },
    { ...base, seq: 9, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 10, type: 'text.delta', messageId: 'answer', text: 'The count lives in one file.' },
    { ...base, seq: 11, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 12, type: 'session.state', state: 'idle', label: 'Ready' },
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'codex', title: 'Tool row height', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Tool row height', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Tool row height', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat&chat=${CHAT}`);

    const toggles = page.getByTestId('tool-toggle');
    await expect(toggles).toHaveCount(2, { timeout: 60_000 });
    await page.getByTestId('thinking-toggle').first().waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'tests/results/tool-row-height-phone.png', fullPage: false });

    for (const line of [...(await toggles.all()), page.getByTestId('thinking-toggle').first()]) {
      const drawn = await line.evaluate((el) => {
        const band = getComputedStyle(el, '::before');
        return { height: el.getBoundingClientRect().height, band: band.content !== 'none' ? parseFloat(band.height) : 0 };
      });
      // The line is the height of its words, not the floor's…
      expect(drawn.height).toBeLessThan(TAP);
      // …and the thumb still reaches it through the band.
      expect(drawn.band).toBe(TAP);
    }
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
