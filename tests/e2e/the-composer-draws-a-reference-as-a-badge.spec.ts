import { expect, test } from '@playwright/test';

import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

/**
 * The writing box draws a file reference as a badge, and still sends the
 * characters that were typed (bw-gr8y.6).
 *
 * The box is a CodeMirror line now, so this is the only case that proves the
 * drawing: a reference is REPLACED on screen by a pill, the pill says what our
 * own form would say however the reference was written, and the value the rest
 * of the app reads off `composer` is still exactly what went in. A unit test
 * can say all three; only a browser can show that the pill is a pill.
 *
 * The chat is a fixture rather than a live agent: nothing here needs an agent
 * to answer, only a chat that is his to write in.
 */

const CHAT = 'composer-badge-fixture';

test('a reference typed into the composer is drawn as a badge over its own characters', async ({ page, request }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const run = join(process.cwd(), 'tests', '.workbench-run-composer-badge');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: 'Tell me which files to look at.' },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
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
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'claude', title: 'Composer badges', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Composer badges', cwd: projectPath, beads: [] } }));

  // Our own form, the form Claude Code's JetBrains plugin pastes, and a folder.
  const line = 'Compare @src/workbench/paths.ts:12-40 with @src/a.ts#L3-L9 under @docs/designs/ and say what moved.';

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Composer badge fixture', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Composer badges' }).getByTestId('row-name').click();
    await expect(page.getByText('Tell me which files to look at.')).toBeVisible();

    // Typed the way he types it, into the line he sees — not filled into the
    // form control underneath, which would prove nothing about the drawing.
    const writing = page.getByTestId('composer-frame').locator('.cm-content');
    await writing.click();
    await page.keyboard.type(line);

    const badges = page.getByTestId('composer-reference');
    await expect(badges).toHaveCount(3);
    // Each one says what WE would have written, whichever form went in.
    await expect(badges.nth(0)).toHaveAttribute('data-reference', 'src/workbench/paths.ts:12-40');
    await expect(badges.nth(1)).toHaveAttribute('data-reference', 'src/a.ts:3-9');
    await expect(badges.nth(2)).toHaveAttribute('data-reference', 'docs/designs/');
    // And the characters underneath are untouched, which is what gets sent.
    await expect(page.getByTestId('composer')).toHaveValue(line);

    await page.getByTestId('composer-frame').screenshot({
      path: 'tests/results/bw-gr8y6-composer-badges.png',
      animations: 'disabled',
    });
    await page.screenshot({ path: 'tests/results/bw-gr8y6-composer-in-the-chat.png', fullPage: false });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
