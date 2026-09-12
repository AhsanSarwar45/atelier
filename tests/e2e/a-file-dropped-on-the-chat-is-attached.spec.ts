import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';

import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * A file dropped anywhere on the conversation is attached (bw-p4r3.1).
 *
 * Only the writing line took a drop, because CodeMirror answers `drop` on its
 * own content. The gesture people make is aimed at the big target — the
 * transcript filling the screen — and a drop nobody catches is one the browser
 * answers by leaving the app and opening the file.
 *
 * Driven with a real DataTransfer carrying a real file, because that is the
 * only part of this that could be wrong: every interesting rule here — is this
 * drag carrying files, did the box already take it — reads the event.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-file-dropped-on-the-chat-is-attached.spec.ts
 */

const WAIT = 60_000;
const SHOTS = join(process.cwd(), 'tests', 'results');
const CHAT = 'a-file-dropped-on-the-chat-is-attached';
const FIXTURE = join(process.cwd(), 'tests', `.workbench-run-${CHAT}`);
const FIXTURES = join(__dirname, '..', 'fixtures', 'files-preview');

async function openTheBox(page: Page, request: { post: Function; get: Function }): Promise<void> {
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(join(FIXTURE, 'keep'), '');
  copyFileSync(join(FIXTURES, 'notes.txt'), join(FIXTURE, 'notes.txt'));

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  const made = await request.post('/api/projects', { data: { name: CHAT, path: FIXTURE, isTest: true } });
  expect([201, 409], await made.text()).toContain(made.status());
  const project =
    made.status() === 201
      ? ((await made.json()) as { id: string })
      : ((await (await request.get('/api/projects?include_test=true')).json()) as { id: string; name: string }[])
          .find((one) => one.name === CHAT)!;
  expect(project?.id, 'the project the run opens').toBeTruthy();

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: FIXTURE, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'session.menu', commands: [], skills: [], models: [], permissionModes: ['on-request', 'plan'], collaborationModes: [], efforts: [], agentDefinitions: [], configOptions: [], agentControls: [] },
    { ...base, seq: 3, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') !== chat) return;
        setTimeout(() => this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
        })), 0);
      }
      close() {}
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, view: foldAll(events) });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({
    json: { sessionId: CHAT, origin: 'app', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Dropped in', cwd: FIXTURE, beads: [] },
  }));

  await page.goto(`/project?id=${project.id}&chat=${CHAT}`);
  await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: WAIT });
  await expect(page.getByTestId('composer-frame')).toBeVisible({ timeout: WAIT });
}

test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

/** A DataTransfer in the page, carrying one real file off this disk. */
async function carrying(page: Page, file: string) {
  const bytes = Array.from(readFileSync(file));
  return page.evaluateHandle(
    ({ name, type, data }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(data)], name, { type }));
      return transfer;
    },
    { name: basename(file), type: basename(file).endsWith('.png') ? 'image/png' : 'text/plain', data: bytes },
  );
}

test('a file dropped on the conversation is attached, and the pane says so first', async ({ page, request }) => {
  test.setTimeout(180_000);
  await openTheBox(page, request);

  const tiles = page.getByTestId('attachment-thumb');
  await expect(tiles).toHaveCount(0);

  const dataTransfer = await carrying(page, join(FIXTURES, 'shot.png'));
  const onto = page.getByTestId('transcript');

  // While it is over the pane, the pane says it will take it.
  await onto.dispatchEvent('dragenter', { dataTransfer });
  await onto.dispatchEvent('dragover', { dataTransfer });
  await expect(page.getByTestId('file-drop-veil')).toBeVisible({ timeout: WAIT });
  await page.screenshot({ path: join(SHOTS, 'bw-p4r3-1-over-the-conversation.png'), animations: 'disabled' });

  await onto.dispatchEvent('drop', { dataTransfer });
  await expect(page.getByTestId('file-drop-veil')).toHaveCount(0, { timeout: WAIT });

  // And it is attached exactly as the paperclip would have attached it.
  await expect(tiles).toHaveCount(1, { timeout: WAIT });
  await expect(tiles.first()).toHaveAccessibleName('shot.png');
  await expect(page.getByTestId('composer-image-badge')).toHaveCount(1, { timeout: WAIT });
  await page.screenshot({ path: join(SHOTS, 'bw-p4r3-1-dropped-in.png'), animations: 'disabled' });
});

test('a file dropped on the writing line lands there once, not twice', async ({ page, request }) => {
  test.setTimeout(180_000);
  await openTheBox(page, request);

  const dataTransfer = await carrying(page, join(FIXTURES, 'notes.txt'));
  // The box is CodeMirror's own content, which answers the drop itself; the
  // pane around it must leave that drop alone rather than attach a second copy.
  await page.locator('.cm-content').dispatchEvent('drop', { dataTransfer });

  await expect(page.getByTestId('attachment-thumb')).toHaveCount(1, { timeout: WAIT });
  await expect(page.getByTestId('composer-image-badge')).toHaveCount(1, { timeout: WAIT });
});
