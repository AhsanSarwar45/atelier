import { expect, test } from '@playwright/test';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

/**
 * A file named in a message is a badge; one on a row is a link
 * (bw-un8y.1, bw-1e2e.1).
 *
 * One chat carries both sides, because the whole rule is where the line is
 * drawn. The message names files every way an agent writes them — in a
 * sentence, quoted in backticks, inside a command it quoted, and in a fenced
 * block — and all of them are files. The activity rows above it name files too,
 * on their collapsed line and inside the command behind it, and those stay the
 * plain link: a row is one dense already-coloured line to read across, not a
 * sentence.
 *
 * Disk is answered here rather than by the machine running this, so the message
 * can name files without any of them having to exist on the runner — the same
 * stand-in `chat-paths.spec.ts` uses.
 *
 * Set PATH_BADGE_BEFORE to take the picture without checking anything: that is
 * how the "before" half of this change's evidence was taken, against a copy of
 * the app that had not been changed yet and so could not pass the checks.
 */

const CHAT = 'a-file-in-a-message-fixture';

test('a file in a message is a badge, and one on a row stays a link', async ({ page, request }) => {
  // Tall enough that both rows and the whole message are in one frame: the
  // picture is the evidence, and a row scrolled off it proves nothing.
  await page.setViewportSize({ width: 1100, height: 900 });
  const run = join(process.cwd(), 'tests', '.workbench-run-path-badge');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const edited = join(projectPath, 'src', 'sessions.ts');
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  writeFileSync(edited, Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n'));

  const body = join(projectPath, 'PR_BODY.md');
  const renderer = join(projectPath, 'src', 'markdown-body.tsx');
  const text = [
    `Written outside the repo, so it stays out of git: ${body} is where it went.`,
    '',
    `Quoted on its own: \`${renderer}\` is the renderer.`,
    '',
    `Use it with \`gh pr create -F ${body}\` when you are ready.`,
    '',
    'And the line it is on:',
    '',
    '```',
    `sed -n 132p ${renderer}`,
    '```',
  ].join('\n');

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'tool.started', toolCallId: 'ran', name: 'Bash', input: { command: `sed -n 132p ${renderer}` }, title: `Read a file in ${projectPath}`, parentToolCallId: null },
    { ...base, seq: 3, type: 'tool.completed', toolCallId: 'ran', ok: true, output: 'line 132' },
    { ...base, seq: 4, type: 'tool.started', toolCallId: 'edit', name: 'Edit', input: { file_path: edited }, title: `Changed ${edited}`, parentToolCallId: null },
    { ...base, seq: 5, type: 'diff', toolCallId: 'edit', path: edited, before: 'line 72\nline 73', after: 'line 72\nchanged line 73', line: 73 },
    { ...base, seq: 6, type: 'tool.completed', toolCallId: 'edit', ok: true, output: 'Done' },
    { ...base, seq: 7, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 8, type: 'text.delta', messageId: 'answer', text },
    { ...base, seq: 9, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 10, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const snapshot = foldAll(events);

  // Every address inside the fixture project is a real file, and nothing else is.
  await page.route('**/api/fs/exists?*', async (route) => {
    const asked = new URL(route.request().url()).searchParams.get('path') ?? '';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ exists: asked.startsWith(projectPath) }) });
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'claude', title: 'Files in a message', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Files in a message', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'File badge fixture', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Files in a message' }).getByTestId('row-name').click();
    await expect(page.getByText('Written outside the repo')).toBeVisible();

    // Nothing but a message draws a badge, so the whole conversation is the
    // scope: a badge found anywhere in it came from the words.
    const message = page.locator('[data-testid="transcript"]');

    // Disk is asked over the wire and the chips appear when it answers, so the
    // picture waits for them however it is being drawn. Without this the
    // "before" frame was taken mid-answer and showed plain words that the copy
    // it was proving would have chipped a moment later.
    await expect
      .poll(async () => message.locator('[data-testid="path-chip"]').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);

    if (!process.env.PATH_BADGE_BEFORE) {
      // Four files named four different ways in one message, and all four are
      // files: the sentence, the backticks, the quoted command, the block.
      await expect.poll(async () => message.locator('[data-path-look="badge"]').count(), { timeout: 30_000 }).toBe(4);
      // Drawn by kind, the same way a markdown link to a file is drawn.
      // Two `.md` and two `.tsx`, each drawn as the kind it is.
      await expect(message.locator('[data-path-look="badge"][data-file-kind="text"]')).toHaveCount(2);
      await expect(message.locator('[data-path-look="badge"][data-file-kind="code"]')).toHaveCount(2);
      // The quoted command is still a command: only the name became a chip.
      const command = message.locator('code', { hasText: 'gh pr create' }).first();
      await expect(command).toHaveText(`gh pr create -F ${body}`);
      await expect(command.locator('[data-path-look="badge"]')).toHaveCount(1);

      // A long address wraps inside its badge rather than running off the
      // side of the message, and the icon sits in the middle of however tall
      // that leaves the badge — not pinned against its first line.
      const wrapped = message.locator('[data-path-look="badge"]').first();
      const box = (await wrapped.boundingBox())!;
      const icon = (await wrapped.locator('svg').first().boundingBox())!;
      expect(box.height, 'the badge under test did not wrap, so this proves nothing').toBeGreaterThan(24);
      expect(
        Math.abs(icon.y + icon.height / 2 - (box.y + box.height / 2)),
        'the icon is not in the middle of the badge it marks',
      ).toBeLessThanOrEqual(1);

      // And the rows above it, which are not a sentence, keep the plain link.
      const rows = page.locator('[data-testid="tool-row"]');
      await expect.poll(async () => rows.locator('[data-path-look="link"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
      expect(await rows.locator('[data-path-look="badge"]').count(), 'a row drew a file as a badge').toBe(0);
    }

    await page.screenshot({
      path: process.env.PATH_BADGE_SCREENSHOT || 'tests/results/bw-1e2e-after.png',
      fullPage: false,
    });
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
