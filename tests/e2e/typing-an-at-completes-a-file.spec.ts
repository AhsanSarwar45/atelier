import { expect, test } from '@playwright/test';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

/**
 * Typing `@` in the composer offers the files of the checkout (bw-gr8y.7).
 *
 * The unit cases can say that the source asks the right question and inserts
 * the right characters. Only a browser can say that a reader who types `@git-v`
 * SEES a menu — with the file's own icon, its name, and the folder it lives in
 * written dimly beside it — and that picking the top line leaves a badge in the
 * writing box rather than a path he has to read.
 *
 * The tree is real: a fixture project with real files on disk and a real
 * `.gitignore`, searched through the real `/api/fs/find`. Only the chat is a
 * fixture, because nothing here needs an agent to answer.
 */

const CHAT = 'composer-at-fixture';

/** A checkout with something worth finding in it, and something to ignore. */
function fillOut(root: string): void {
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('src/workbench/git-view.tsx', 'export const GitView = () => null;\n');
  write('src/workbench/git-diff-view.tsx', 'export const GitDiffView = () => null;\n');
  write('src/workbench/agent-view.tsx', 'export const AgentView = () => null;\n');
  write('docs/designs/one.md', '# a design\n');
  // Ignored, and named so that it would otherwise be the FIRST answer for
  // `git-v`: a shorter path with the same basename hit.
  writeFileSync(join(root, '.gitignore'), 'build/\n');
  write('build/git-v.js', 'made\n');
}

test('typing @ offers the checkout’s files and picking one leaves a badge', async ({ page, request }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const run = join(process.cwd(), 'tests', '.workbench-run-composer-at');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  fillOut(projectPath);

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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'claude', title: 'Composer at menu', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Composer at menu', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Composer at fixture', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Composer at menu' }).getByTestId('row-name').click();
    await expect(page.getByText('Tell me which files to look at.')).toBeVisible();

    /**
     * Type, and wait until the answer on screen is the answer to what was
     * typed — not to a prefix of it that a keystroke overtook.
     *
     * Every keystroke asks the server again, so between the last character and
     * the menu settling there is a moment when the list still belongs to the
     * character before. Pressing Enter in that moment picks the wrong file, or
     * nothing at all. A reader never notices it; a test that presses keys in
     * microseconds notices it every time.
     */
    const typeAndSettle = async (text: string, asking: string) => {
      const settled = page.waitForResponse(
        (answer) => answer.url().includes(`/api/fs/find?`) && answer.url().includes(`q=${asking}&`),
      );
      await page.keyboard.type(text);
      await settled;
      // And then past CodeMirror's `interactionDelay` (75 ms), which ignores
      // Enter on a menu that has only just appeared so that a fast typist
      // cannot accept a suggestion he has not had time to read. A reader clears
      // it without noticing; a test that types at machine speed does not.
      await page.waitForTimeout(200);
    };

    // Typed the way he types it, into the line he sees.
    const writing = page.getByTestId('composer-frame').locator('.cm-content');
    await writing.click();
    await typeAndSettle('Look at @git-v', 'git-v');

    const menu = page.locator('.cm-tooltip-autocomplete');
    await expect(menu).toBeVisible();
    const lines = menu.locator('li');

    // The card's own case: the file whose NAME answers comes first, ahead of
    // the longer name that also contains it.
    await expect(lines.first()).toContainText('git-view.tsx');
    await expect(lines.first()).toContainText('src/workbench');
    await expect(lines.nth(1)).toContainText('git-diff-view.tsx');
    // Nothing that has nothing to do with it, and nothing git ignores.
    await expect(menu).not.toContainText('agent-view.tsx');
    await expect(menu).not.toContainText('git-v.js');
    // The picture is the file tree's picture, not a letter in a circle.
    await expect(lines.first().locator('img')).toHaveAttribute('data-icon', 'react_ts');

    await page.getByTestId('composer-frame').screenshot({
      path: 'tests/results/bw-gr8y7-at-menu.png',
      animations: 'disabled',
    });
    await page.screenshot({ path: 'tests/results/bw-gr8y7-at-menu-in-the-chat.png', fullPage: false });

    // Enter belongs to the menu while it is open — it picks, it does not send.
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(page.getByTestId('composer')).toHaveValue('Look at @src/workbench/git-view.tsx');
    // And what he is left looking at is a badge, not a path (bw-gr8y.6).
    const badge = page.getByTestId('composer-reference');
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveAttribute('data-reference', 'src/workbench/git-view.tsx');
    // The chat is still there: picking a file sent nothing.
    await expect(page.getByText('Tell me which files to look at.')).toBeVisible();

    await page.getByTestId('composer-frame').screenshot({
      path: 'tests/results/bw-gr8y7-at-picked.png',
      animations: 'disabled',
    });

    // A folder is a step rather than an answer: it ends with a slash and the
    // menu comes back, already narrowed into it.
    await typeAndSettle(' and @docs', 'docs');
    await expect(menu).toBeVisible();
    await expect(lines.first()).toContainText('docs/');
    await expect(lines.first()).toHaveAttribute('aria-selected', 'true');
    // The menu picking itself up again after the folder goes in is the thing
    // being watched, so the wait is for the search the slash sets off.
    const narrowed = page.waitForResponse(
      (answer) => answer.url().includes('/api/fs/find?') && answer.url().includes('q=docs%2F&'),
    );
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer')).toHaveValue(
      'Look at @src/workbench/git-view.tsx and @docs/',
    );
    await narrowed;
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('designs/');
    // Every row has a picture, folders included: a row without one sits out of
    // line with the rest of the list.
    await expect(lines.locator('img')).toHaveCount(await lines.count());

    await page.getByTestId('composer-frame').screenshot({
      path: 'tests/results/bw-gr8y7-at-inside-a-folder.png',
      animations: 'disabled',
    });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
