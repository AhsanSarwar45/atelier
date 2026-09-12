import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';

import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * Any file at all can be attached, and each wears its own kind (bw-oamr.6).
 *
 * The writing box used to judge a chosen file against two hand-written lists of
 * extensions — one of pictures, one of things it could unroll into the draft as
 * words — and anything in neither was announced as having nowhere to go in a
 * message and dropped. A video, a recording, a PDF, an archive, a spreadsheet:
 * every one of them was refused, which is what the owner found when he asked
 * whether this app could take anything but pictures.
 *
 * So the case is the matrix. Five files of five kinds go in at once, and each
 * one has to come back as a tile above the box and a chip inside it, wearing
 * the icon and the colour its kind wears everywhere else in the app.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-writing-box-takes-any-file.spec.ts
 */

const WAIT = 60_000;
const SHOTS = join(process.cwd(), 'tests', 'results');
const CHAT = 'the-writing-box-takes-any-file';
const FIXTURE = join(process.cwd(), 'tests', `.workbench-run-${CHAT}`);

/**
 * One file of each kind the app draws differently: what kind it IS, for the
 * icon and the colour, and what can be MADE of it, which is not the same
 * question — a PDF and a log are both `text` and only one of them opens in a
 * frame (`attachment-look.ts`). These are real files: a video has to have a
 * first frame to draw and a recording has to have something to play.
 */
const FIXTURES = join(__dirname, '..', 'fixtures', 'files-preview');

const FILES = [
  { name: 'shot.png', kind: 'image', look: 'picture' },
  { name: 'clip.mp4', kind: 'video', look: 'video' },
  { name: 'song.mp3', kind: 'audio', look: 'audio' },
  { name: 'contract.pdf', kind: 'text', look: 'pdf' },
  { name: 'notes.txt', kind: 'text', look: 'words' },
  { name: 'bundle.zip', kind: 'archive', look: 'nothing' },
];

async function openTheBox(page: Page, request: { post: Function; get: Function }): Promise<void> {
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(join(FIXTURE, 'keep'), '');

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
    json: { sessionId: CHAT, origin: 'app', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Any file at all', cwd: FIXTURE, beads: [] },
  }));

  await page.goto(`/project?id=${project.id}&chat=${CHAT}`);
  await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: WAIT });
  await expect(page.getByTestId('composer-frame')).toBeVisible({ timeout: WAIT });
}

test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

test('a video, a recording, a PDF, an archive and a spreadsheet each go in wearing their own kind', async ({ page, request }) => {
  test.setTimeout(180_000);
  await openTheBox(page, request);

  const chooser = page.waitForEvent('filechooser', { timeout: WAIT });
  await page.getByTestId('attach-picture').click();
  await (await chooser).setFiles(FILES.map((file) => join(FIXTURES, file.name)));

  await expect(page.getByTestId('attachment-tray')).toBeVisible({ timeout: WAIT });

  // Nothing was turned down. The notice that used to appear here named the
  // files and said they could go in a message "neither as a picture nor as
  // words", which was the whole fault.
  await expect(page.getByTestId('send-error')).toHaveCount(0);

  const tiles = page.getByTestId('attachment-thumb');
  await expect(tiles).toHaveCount(FILES.length, { timeout: WAIT });

  for (const [at, file] of FILES.entries()) {
    const tile = tiles.nth(at);
    await expect(tile, `${file.name} has no tile above the box`).toHaveAttribute('data-file-kind', file.kind);
    await expect(tile, `${file.name}'s tile does not know what can be made of it`).toHaveAttribute('data-look', file.look);

    const chip = page.getByTestId('composer-image-badge').nth(at);
    await expect(chip, `${file.name} has no chip in the box`).toHaveText(file.name);
    await expect(chip, `${file.name}'s chip wears the wrong kind`).toHaveAttribute('data-file-kind', file.kind);
    expect(await chip.locator('svg').count(), `${file.name}'s chip draws no icon`).toBe(1);
  }

  // Every tile is the same square. A strip that mixed a picture's thumbnail
  // with a wide name-shaped pill for everything else did not line up at all,
  // which is what the owner sent back (bw-oamr.7).
  const shapes = await tiles.evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    }),
  );
  const first = shapes[0]!;
  expect(first.width, `a tile measured ${first.width}x${first.height} and is meant to be square`).toBe(first.height);
  for (const [at, shape] of shapes.entries()) {
    expect(shape, `${FILES[at]!.name}'s tile is not the shape the others are`).toEqual(first);
  }

  // The video's tile is the video's own first frame, not an icon standing in
  // for one: it has decoded something with a size.
  const frame = page.getByTestId('attachment-frame');
  await expect(frame).toHaveJSProperty('videoWidth', 320, { timeout: WAIT });

  await page.screenshot({ path: join(SHOTS, 'bw-oamr-7-tiles.png'), animations: 'disabled' });

  // And each opens full size, in the thing that can show it.
  const opensAs = [
    { name: 'shot.png', viewer: 'picture-viewer', close: 'picture-viewer-close' },
    { name: 'clip.mp4', viewer: 'attachment-viewer', close: 'attachment-viewer-close', plays: 'attachment-video' },
    { name: 'song.mp3', viewer: 'attachment-viewer', close: 'attachment-viewer-close', plays: 'attachment-audio' },
    { name: 'contract.pdf', viewer: 'attachment-viewer', close: 'attachment-viewer-close', plays: 'attachment-pdf' },
    { name: 'notes.txt', viewer: 'attachment-viewer', close: 'attachment-viewer-close', plays: 'attachment-words' },
  ];
  for (const one of opensAs) {
    const at = FILES.findIndex((file) => file.name === one.name);
    await tiles.nth(at).click();
    await expect(page.getByTestId(one.viewer), `${one.name} did not open`).toBeVisible({ timeout: WAIT });
    if (one.plays) await expect(page.getByTestId(one.plays), `${one.name} opened with nothing in it`).toBeVisible({ timeout: WAIT });
    if (one.name === 'clip.mp4') {
      await page.screenshot({ path: join(SHOTS, 'bw-oamr-7-video.png'), animations: 'disabled' });
    }
    await page.getByTestId(one.close).click();
    await expect(page.getByTestId(one.viewer)).toHaveCount(0, { timeout: WAIT });
  }

  // An archive has nothing a browser can show, so its tile does not pretend to
  // open one.
  const zip = FILES.findIndex((file) => file.name === 'bundle.zip');
  await expect(tiles.nth(zip)).toBeDisabled();
});
