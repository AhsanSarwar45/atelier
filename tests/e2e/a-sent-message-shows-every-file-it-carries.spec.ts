import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { ImagePayload, WbpEvent } from '../../src/workbench/protocol';
import { makeFixtureProject } from './fixture-board';

/**
 * A sent message shows the same strip it was written with (bw-oamr.9).
 *
 * The strip above the words held pictures only. So the writing box showed a
 * video, a recording and a zip as tiles, and pressing send made all three
 * vanish: the message the owner read back was not the message he wrote.
 *
 * His own message shows everything it carries. The agent's shows only what
 * there is something to look at — a picture, a video, a recording — because a
 * row of icons for every file an agent mentioned would be a second, worse copy
 * of what it already said in words.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-sent-message-shows-every-file-it-carries.spec.ts
 */

const CHAT = 'every-file-it-carries';
const SHOTS = join(process.cwd(), 'tests', 'results');
const FIXTURES = join(__dirname, '..', 'fixtures', 'files-preview');

const CARRIED = [
  { name: 'shot.png', look: 'picture' },
  { name: 'clip.mp4', look: 'video' },
  { name: 'song.mp3', look: 'audio' },
  { name: 'contract.pdf', look: 'pdf' },
  { name: 'notes.txt', look: 'words' },
  { name: 'bundle.zip', look: 'nothing' },
];

test('his message shows every file it carries; the agent’s shows only what can be looked at', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1100, height: 900 });
  const run = join(process.cwd(), 'tests', `.workbench-run-${CHAT}`);
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const files = join(projectPath, 'files');
  mkdirSync(files, { recursive: true });
  for (const one of CARRIED) copyFileSync(join(FIXTURES, one.name), join(files, one.name));

  // Named by where they sit rather than carried as bytes: this is what a
  // message looks like once the store has kept its attachments (bw-oamr.5).
  const carried: ImagePayload[] = CARRIED.map((one) => ({
    mime: '',
    dataUrl: '',
    path: join(files, one.name),
    alt: one.name,
  }));

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'sent', role: 'user', composedHere: true },
    ...carried.map((image, i) => ({ ...base, seq: 3 + i, type: 'image', messageId: 'sent', image })),
    { ...base, seq: 20, type: 'text.delta', messageId: 'sent', text: 'Everything I am sending you' },
    { ...base, seq: 21, type: 'message.completed', messageId: 'sent' },
    { ...base, seq: 22, type: 'message.started', messageId: 'answer', role: 'assistant' },
    ...carried.map((image, i) => ({ ...base, seq: 23 + i, type: 'image', messageId: 'answer', image })),
    { ...base, seq: 40, type: 'text.delta', messageId: 'answer', text: 'And everything back' },
    { ...base, seq: 41, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 42, type: 'session.state', state: 'idle', label: 'Ready' },
  ] as WbpEvent[];

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
  }, { chat: CHAT, view: foldAll(events) });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'claude', title: 'Every file it carries', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Every file it carries', cwd: projectPath, beads: [] } }));

  const made = await request.post('/api/projects', { data: { name: 'Every file it carries', path: projectPath, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };
  await page.goto(`/project?id=${project.id}&tab=chat`);
  await page.getByTestId('restore-row').filter({ hasText: 'Every file it carries' }).getByTestId('row-name').click();
  await expect(page.getByText('Everything I am sending you')).toBeVisible();

  // His own: one cell per file, in writing order, each knowing what it holds.
  const mine = page.locator('[data-testid="user-message"]');
  await expect(mine.locator('[data-testid="message-image"]')).toHaveCount(1);
  await expect(mine.locator('[data-testid="message-attachment"]')).toHaveCount(5);
  expect(
    await mine.locator('[data-testid="message-attachment"]').evaluateAll((cells) =>
      cells.map((cell) => cell.getAttribute('data-look')),
    ),
  ).toEqual(['video', 'audio', 'pdf', 'words', 'nothing']);

  // The video draws its own first frame here too, not an icon standing in.
  await expect(mine.locator('[data-testid="attachment-frame"]')).toHaveJSProperty('videoWidth', 320);

  // The agent's: the three there is something to look at, and no icons.
  const theirs = page.locator('[data-testid="assistant-message"]');
  await expect(theirs.locator('[data-testid="message-image"]')).toHaveCount(1);
  expect(
    await theirs.locator('[data-testid="message-attachment"]').evaluateAll((cells) =>
      cells.map((cell) => cell.getAttribute('data-look')),
    ),
  ).toEqual(['video', 'audio']);

  await page.screenshot({ path: join(SHOTS, 'bw-oamr-9-a-sent-message.png'), animations: 'disabled' });
});
