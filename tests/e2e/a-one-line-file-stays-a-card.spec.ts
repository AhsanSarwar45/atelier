/**
 * An edit to a file that is one enormous line stays the size of a card.
 *
 * What this replaces: a chat that wrote a base64 image drew the whole thing in
 * its edit card. The wire already caps a diff at four hundred LINES, but this
 * was one line — `+1 −0` — of hundreds of thousands of characters, wrapped
 * into thousands of rows on the screen, and the reader scrolled for miles to
 * get past it (bw-p7xm). A line is now drawn only so far, and says how much
 * of it was left out.
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import { changeOf } from '../../src/workbench/line-diff';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

/** A base64 file as a chat writes one: a single line, no breaks. */
const LINE = 'iVBORw0KGgoAAAANSUhEUgAAB3EAAAgFCAIAAADne8+0AAAAAXNSR0IArs4c6QAAIABJREFUeAHs3XlcVdXC'.repeat(2500);
const FILE = `${LINE}\n`;

test('a one-line file of 200,000 characters draws as a card, not a column', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1100, height: 900 });
  const run = join(process.cwd(), 'tests', '.workbench-run-one-line-file');
  const chat = 'one-line-file';
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const edited = join(projectPath, 'redesign-after.b64');

  const base = { sessionId: chat, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: projectPath, permissionMode: 'default' },
    { ...base, seq: 2, type: 'tool.started', toolCallId: 'edit', name: 'Write', input: { file_path: edited }, title: `Changed ${edited}`, parentToolCallId: null },
    {
      ...base, seq: 3, type: 'diff', toolCallId: 'edit', path: edited,
      before: '', after: `${FILE.slice(0, 4000)}\n… and ${FILE.length - 4000} more characters`, line: 1,
      ...changeOf('', FILE),
    },
    { ...base, seq: 4, type: 'tool.completed', toolCallId: 'edit', ok: true, output: 'File created.' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const view = foldAll(events);

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
  }, { chat, view });
  await page.route('**/api/fs/exists?*', (route) => route.fulfill({ json: { exists: true } }));
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: chat, externalId: 'fixture', brand: 'claude', title: 'One-line file', name: 'One-line file', origin: 'terminal', projectId: null, folder: null, branch: null, state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${chat}$`), (route) => route.fulfill({ json: { sessionId: chat, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'One-line file', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'One-line file', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = (await made.json()) as { id: string };
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'One-line file' }).getByTestId('row-name').click();
    await expect(page.getByTestId('tool-row').first()).toHaveAttribute('data-open', 'true', { timeout: 60_000 });

    const card = page.getByTestId('diff-view');
    await expect(card.getByTestId('diff-counts')).toContainText('+1');
    await page.screenshot({ path: `tests/results/bw-p7xm-${process.env.SHOT ?? 'after'}.png` });

    // The one line is drawn only so far, and says how much it left out…
    await expect(card).toContainText(/more characters/);
    // …so the card is a card, and not a column running off the screen.
    const box = await card.boundingBox();
    expect(box!.height).toBeLessThan(600);
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
