/**
 * A large edit card says how many LINES changed and draws them.
 *
 * What this replaces: the card read "53,935 characters hidden" and drew no
 * code at all, because the wire had cut the text to its first four thousand
 * characters — the top of the file, and not the part that changed (bw-2xjd.1
 * was the honest thing to do with that). The wire now takes the diff before
 * the cut, so the change itself crosses and the card reads +1 −1 and draws
 * the changed lines in their place (bw-vl3q.3).
 *
 * Both states are photographed from the same edit, so the pair is a before and
 * an after of one change rather than two different files.
 */
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import { changeOf } from '../../src/workbench/line-diff';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

/** A file large enough that the wire's four-thousand-character bound bites. */
const FILE = Array.from({ length: 1500 }, (_, at) => `const line${at + 1} = ${at + 1};`).join('\n') + '\n';
const CHANGED = FILE.replace('const line1400 = 1400;', 'const line1400 = 1401;');

/** A body as the wire delivers it: cut, and saying how much was cut. */
const asDelivered = (text: string) => `${text.slice(0, 4000)}\n… and ${text.length - 4000} more characters`;

/**
 * The one chat, told either way.
 *
 * `counted` is the whole difference: with it the diff event carries what the
 * server worked out before it cut the text, and without it the event is the
 * bare three fields an older stored one has.
 */
function snapshotOf(chat: string, edited: string, counted: boolean) {
  const base = { sessionId: chat, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'codex', externalId: 'fixture', model: 'gpt-5', cwd: join(edited, '..', '..'), permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'tool.started', toolCallId: 'edit', name: 'Write', input: { file_path: edited }, title: `Changed ${edited}`, parentToolCallId: null },
    {
      ...base, seq: 3, type: 'diff', toolCallId: 'edit', path: edited,
      before: asDelivered(FILE), after: asDelivered(CHANGED), line: 1,
      ...(counted ? changeOf(FILE, CHANGED) : {}),
    },
    { ...base, seq: 4, type: 'tool.completed', toolCallId: 'edit', ok: true, output: 'The file has been updated.' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  return foldAll(events);
}

/** The fixture chat, opened, with its one edit card on the screen. */
async function openTheChat(page: Page, request: APIRequestContext, chat: string, counted: boolean, run: string) {
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const edited = join(projectPath, 'src', 'git-view.tsx');
  const view = snapshotOf(chat, edited, counted);

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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: chat, externalId: 'fixture', brand: 'codex', title: 'Large edit', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${chat}$`), (route) => route.fulfill({ json: { sessionId: chat, origin: 'terminal', brand: 'codex', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Large edit', cwd: projectPath, beads: [] } }));

  const made = await request.post('/api/projects', { data: { name: `Large edit ${chat}`, path: projectPath, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };
  await page.goto(`/project?id=${project.id}&tab=chat`);
  await page.getByTestId('restore-row').filter({ hasText: 'Large edit' }).getByTestId('row-name').click();
  const row = page.getByTestId('tool-row').first();
  await expect(row).toHaveAttribute('data-open', 'true', { timeout: 60_000 });
  return { project, row };
}

test('a large edit reads in lines and draws the lines that changed', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1100, height: 720 });
  const run = join(process.cwd(), 'tests', '.workbench-run-large-edit-lines');

  let project: { id: string } | null = null;
  try {
    // How it read before: a measurement of what the card was not sent.
    const was = await openTheChat(page, request, 'large-edit-was', false, run);
    project = was.project;
    await expect(page.getByTestId('diff-summary')).toContainText('characters hidden');
    await expect(page.getByTestId('diff-table')).toHaveCount(0);
    await page.getByTestId('diff-view').screenshot({ path: 'tests/results/bw-vl3q-before.png' });
    await request.delete(`/api/projects/${project.id}`);
    project = null;
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
  }

  try {
    // How it reads now: the count, and the change in its place in the file.
    const now = await openTheChat(page, request, 'large-edit-now', true, run);
    project = now.project;

    const counts = page.getByTestId('diff-counts');
    await expect(counts).toContainText('+1');
    await expect(counts).toContainText('−1');
    await expect(page.getByTestId('diff-summary')).toHaveCount(0);

    const view = page.getByTestId('diff-view');
    await expect(view).toContainText('const line1401 = 1401;');
    // Context either side, so the change is read where it happened…
    await expect(view).toContainText('const line1394 = 1394;');
    // …and not the top of the file, which is all the cut text ever held.
    await expect(view).not.toContainText('const line1 = 1;');
    await view.screenshot({ path: 'tests/results/bw-vl3q-after.png' });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
