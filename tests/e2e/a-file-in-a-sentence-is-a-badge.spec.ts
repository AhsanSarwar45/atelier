import { expect, test } from '@playwright/test';

import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

/**
 * A file named in an agent's own words is drawn as a file (bw-un8y.1).
 *
 * The same message carries every way an agent writes one: in a sentence, quoted
 * on its own, inside a command it quoted, and inside a fenced block. What each
 * one turns into is the whole of the change, so they are proved together and in
 * one picture.
 *
 * Disk is answered here rather than by the machine running this, so the message
 * can name files without any of them having to exist on the runner — the same
 * stand-in `chat-paths.spec.ts` uses.
 *
 * Set PATH_BADGE_BEFORE to take the picture without checking anything: that is
 * how the "before" half of this change's evidence was taken, against a copy of
 * the app that had not been changed yet and so could not pass the checks.
 */

const CHAT = 'a-file-in-a-sentence-fixture';
const HOME = '/home/me/worktrees/bw-un8y.1';

test('a file in a sentence is a badge, and one in a command stays a link', async ({ page, request }) => {
  await page.setViewportSize({ width: 1100, height: 640 });
  const run = join(process.cwd(), 'tests', '.workbench-run-path-badge');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const text = [
    `Written outside the repo, so it stays out of git: ${HOME}/PR_BODY.md is where it went.`,
    '',
    `Quoted on its own: \`${HOME}/src/components/markdown-body.tsx\` is the renderer.`,
    '',
    `Use it with \`gh pr create -F ${HOME}/PR_BODY.md\` when you are ready.`,
    '',
    'And the line it is on:',
    '',
    '```',
    `sed -n 132p ${HOME}/src/components/markdown-body.tsx`,
    '```',
  ].join('\n');
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const snapshot = foldAll(events);

  // Every address this message names is a real file, and nothing else is.
  await page.route('**/api/fs/exists?*', async (route) => {
    const asked = new URL(route.request().url()).searchParams.get('path') ?? '';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: asked.startsWith(HOME) }) });
  });

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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'claude', title: 'Files in a sentence', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Files in a sentence', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'File badge fixture', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Files in a sentence' }).getByTestId('row-name').click();
    await expect(page.getByText('Written outside the repo')).toBeVisible();

    if (!process.env.PATH_BADGE_BEFORE) {
      const chips = page.locator('[data-testid="transcript"] [data-testid="path-chip"]');
      await expect.poll(async () => chips.count(), { timeout: 30_000 }).toBe(4);

      // A file in a sentence, and one quoted on its own, are both files.
      await expect(page.locator('[data-path-look="badge"]')).toHaveCount(2);
      // Drawn by kind, the same way a markdown link to a file is drawn.
      await expect(page.locator('[data-path-look="badge"][data-file-kind="text"]')).toHaveCount(1);
      await expect(page.locator('[data-path-look="badge"][data-file-kind="code"]')).toHaveCount(1);

      // A file inside a command is a link, and the command is still a command.
      await expect(page.locator('[data-path-look="link"]')).toHaveCount(2);
      const command = page.locator('code', { hasText: 'gh pr create' }).first();
      await expect(command).toHaveText(`gh pr create -F ${HOME}/PR_BODY.md`);
      await expect(command.locator('[data-path-look="link"]')).toHaveCount(1);
    }

    await page.screenshot({
      path: process.env.PATH_BADGE_SCREENSHOT || 'tests/results/bw-un8y-after.png',
      fullPage: false,
    });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
