import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';

import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The strip above the writing box and the badges inside it are one list
 * (bw-oamr.8).
 *
 * They were two readings of the draft: the strip read the attached files, the
 * badges read those AND every path typed in the line. So a path the reader
 * wrote had a badge and no tile, and there was no way to take it back out
 * except by finding the characters and deleting them.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-strip-and-the-badges-are-one-thing.spec.ts
 */

const WAIT = 60_000;
const SHOTS = join(process.cwd(), 'tests', 'results');
const CHAT = 'the-strip-and-the-badges-are-one-thing';
const FIXTURE = join(process.cwd(), 'tests', `.workbench-run-${CHAT}`);
const FIXTURES = join(__dirname, '..', 'fixtures', 'files-preview');

async function openTheBox(page: Page, request: { post: Function; get: Function }): Promise<void> {
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(join(FIXTURE, 'keep'), '');
  // Something real for the typed path to name.
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
    json: { sessionId: CHAT, origin: 'app', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'One list', cwd: FIXTURE, beads: [] },
  }));

  await page.goto(`/project?id=${project.id}&chat=${CHAT}`);
  await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: WAIT });
  await expect(page.getByTestId('composer-frame')).toBeVisible({ timeout: WAIT });
}

test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

test('a typed path gets a tile, and its X takes the path out of the words', async ({ page, request }) => {
  test.setTimeout(180_000);
  await openTheBox(page, request);

  const box = page.getByTestId('composer');
  const tiles = page.getByTestId('attachment-thumb');
  const badges = page.getByTestId('composer-reference');

  // A path typed in the line is a file the message carries, so it is in the
  // strip as well as in the words.
  await box.fill('please read @notes.txt and say what it means');
  await expect(badges).toHaveCount(1, { timeout: WAIT });
  await expect(tiles).toHaveCount(1, { timeout: WAIT });
  await expect(tiles.first()).toHaveAttribute('data-look', 'words');
  await expect(tiles.first()).toHaveAccessibleName('notes.txt');

  await page.screenshot({ path: join(SHOTS, 'bw-oamr-8-a-typed-path.png'), animations: 'disabled' });

  // And its X takes the characters out of the line, which takes the badge with
  // them — there is only one list.
  await page.getByTestId('attachment-remove').first().click();
  await expect(tiles).toHaveCount(0, { timeout: WAIT });
  await expect(badges).toHaveCount(0, { timeout: WAIT });
  await expect(box).toHaveValue('please read and say what it means');
});

test('an attached file and a typed path stand in the strip together, in writing order', async ({ page, request }) => {
  test.setTimeout(180_000);
  await openTheBox(page, request);

  const chooser = page.waitForEvent('filechooser', { timeout: WAIT });
  await page.getByTestId('attach-picture').click();
  await (await chooser).setFiles([join(FIXTURES, 'shot.png')]);

  const tiles = page.getByTestId('attachment-thumb');
  await expect(tiles).toHaveCount(1, { timeout: WAIT });

  await page.getByTestId('composer').press('End');
  await page.getByTestId('composer').type(' and @notes.txt too');
  await expect(tiles).toHaveCount(2, { timeout: WAIT });
  await expect(tiles.nth(0)).toHaveAccessibleName('shot.png');
  await expect(tiles.nth(1)).toHaveAccessibleName('notes.txt');

  // Taking the picture out takes its badge with it, and leaves the path alone.
  await page.getByTestId('attachment-remove').first().click();
  await expect(tiles).toHaveCount(1, { timeout: WAIT });
  await expect(page.getByTestId('composer-image-badge')).toHaveCount(0);
  await expect(tiles.first()).toHaveAccessibleName('notes.txt');
});
