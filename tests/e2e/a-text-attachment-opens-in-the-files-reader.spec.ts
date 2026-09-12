import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';

import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * A text attachment opens in the Files tab's own reader (bw-p4r3.2).
 *
 * It used to open in a `<pre>` this dialog drew for itself: no grammar, no
 * colour, no folding — beside a Files tab that has done all three since
 * bw-g3o3. One reader now, chosen by the file's name, so an attached `.ts` is
 * as readable in a message as it is in the tree.
 *
 * Proved by the colour: a keyword is only wrapped in a coloured span once a
 * grammar has been fetched and run over the text, so a painted `export` on
 * screen is the highlighting itself and not a class name copied into a test.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-text-attachment-opens-in-the-files-reader.spec.ts
 */

const WAIT = 60_000;
const SHOTS = join(process.cwd(), 'tests', 'results');
const CHAT = 'a-text-attachment-opens-in-the-files-reader';
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
    json: { sessionId: CHAT, origin: 'app', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Read it properly', cwd: FIXTURE, beads: [] },
  }));

  await page.goto(`/project?id=${project.id}&chat=${CHAT}`);
  await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: WAIT });
  await expect(page.getByTestId('composer-frame')).toBeVisible({ timeout: WAIT });
}

test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

test('an attached source file opens highlighted, in the reader the Files tab uses', async ({ page, request }) => {
  test.setTimeout(180_000);
  await openTheBox(page, request);

  const chooser = page.waitForEvent('filechooser', { timeout: WAIT });
  await page.getByTestId('attach-picture').click();
  await (await chooser).setFiles([join(FIXTURES, 'module.ts')]);

  const tiles = page.getByTestId('attachment-thumb');
  await expect(tiles).toHaveCount(1, { timeout: WAIT });
  await tiles.first().click();

  const words = page.getByTestId('attachment-words');
  await expect(words).toBeVisible({ timeout: WAIT });
  // CodeMirror's own editor, with the file's text in it.
  await expect(words.locator('.cm-editor')).toBeVisible({ timeout: WAIT });
  await expect(words).toContainText('export function greet', { timeout: WAIT });
  // And a grammar really ran. The classes CodeMirror paints a token with are
  // generated (`ͼ…`), so the proof is the same one the Files tab's own test
  // takes: a coloured span whose text is a keyword of the language.
  await expect
    .poll(async () =>
      page.$$eval('[data-testid="attachment-words"] .cm-content span[class]', (spans) =>
        spans.filter((span) => span.className.startsWith('ͼ')).map((span) => span.textContent),
      ),
    )
    .toContain('export');

  await page.screenshot({ path: join(SHOTS, 'bw-p4r3-2-a-source-attachment.png'), animations: 'disabled' });

  await page.getByTestId('attachment-viewer-close').click();
  await expect(page.getByTestId('attachment-viewer')).toHaveCount(0, { timeout: WAIT });
});

test('a plain text attachment still opens, and says what it says', async ({ page, request }) => {
  test.setTimeout(180_000);
  await openTheBox(page, request);

  const chooser = page.waitForEvent('filechooser', { timeout: WAIT });
  await page.getByTestId('attach-picture').click();
  await (await chooser).setFiles([join(FIXTURES, 'notes.txt')]);

  await page.getByTestId('attachment-thumb').first().click();
  await expect(page.getByTestId('attachment-words')).toContainText('first line of the notes', { timeout: WAIT });
});
