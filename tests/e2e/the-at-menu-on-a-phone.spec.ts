import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The `@` menu and what it writes, on a phone (bw-7ihk5.1).
 *
 *  * A finger that drags the menu scrolls it. Picking on the finger's landing
 *    chose the first line touched and shut the menu, so it could not scroll.
 *  * An `@word` that names no file is words: no badge, no tile above the box.
 *    `@skill` left behind by Backspace was drawn as a file called `skill`.
 *  * Backspace after a badge, through the editor's Android input path, takes
 *    the whole reference and leaves the box focused.
 *  * Copying a sent message gives back its references as they were written,
 *    not the badges' labels each on a line of its own.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/the-at-menu-on-a-phone.spec.ts
 */

const SHOTS = 'tests/results/at-menu-on-a-phone';
const WAIT = 60_000;
const CHAT = 'at-menu-phone-chat';

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src'), { recursive: true });
  writeFileSync(join(where, 'README.md'), '# A project\n');
  // Enough files that the menu has to scroll.
  for (let n = 10; n < 40; n++) writeFileSync(join(where, 'src', `file-${n}.ts`), `export const n = ${n};\n`);
}

async function openTheBox(page: Page, request: APIRequestContext, fixture: string, said?: string) {
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: fixture, permissionMode: 'on-request' },
    ...(said ? [
      { ...base, seq: 2, type: 'message.started', messageId: 'q', role: 'user' },
      { ...base, seq: 3, type: 'text.delta', messageId: 'q', text: said },
      { ...base, seq: 4, type: 'message.completed', messageId: 'q' },
    ] as WbpEvent[] : []),
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') !== chat) return;
        setTimeout(() => this.onmessage?.(new MessageEvent('message', {
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({
    json: { sessionId: CHAT, origin: 'app', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'At menu', cwd: fixture, beads: [] },
  }));
  const made = await request.post('/api/projects', { data: { name: `${basename(fixture)}-${Date.now()}`, path: fixture, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${CHAT}`);
  await expect(page.getByTestId('composer-frame')).toBeVisible({ timeout: WAIT });
  return project;
}

test('a finger scrolls the @ menu, and a tap picks', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(__dirname, '..', `.workbench-run-at-menu-phone-${test.info().repeatEachIndex}`);
  seed(fixture);
  mkdirSync(SHOTS, { recursive: true });
  const project = await openTheBox(page, request, fixture);
  try {
    await page.getByTestId('composer-frame').locator('.cm-content').tap();
    await page.keyboard.type('@src/file');
    const list = page.locator('.cm-tooltip-autocomplete > ul');
    // The menu asks where the chat is working, which can arrive after the
    // typing did; the last letter is typed again until it has.
    const files = page.locator('[data-testid="mention-tab"][data-scope="file"]');
    await expect(async () => {
      await page.keyboard.press('Backspace');
      await page.keyboard.type('e');
      await expect(files).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: WAIT });
    // All shows a few files beside the other kinds; Files shows enough to scroll.
    await files.tap();
    await expect(list.locator('li[id]').nth(10)).toBeAttached({ timeout: WAIT });

    // A real touch drag up the list, from a line in it, once the menu has
    // settled where it is drawn.
    await page.waitForTimeout(500);
    const box = (await list.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const x = Math.round(box.x + box.width / 2);
    const from = Math.round(box.y + box.height - 20);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
    for (let step = 1; step <= 12; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from - step * 15 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect(list, 'the menu shut instead of scrolling').toBeVisible();
    expect(await list.evaluate((ul) => ul.scrollTop), 'the menu did not scroll').toBeGreaterThan(0);
    await expect(page.getByTestId('composer'), 'the drag picked a line').toHaveValue('@src/file');
    await page.screenshot({ path: `${SHOTS}/scrolled.png`, animations: 'disabled' });

    // A tap on a line still picks it.
    const line = list.locator('li[id]').nth(8);
    const name = (await line.locator('.cm-completionLabel').textContent())!.trim();
    await line.tap();
    await expect(page.getByTestId('composer')).toHaveValue(`@src/${name} `);
    await expect(page.getByTestId('composer-reference')).toHaveCount(1);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('an @ word that names no file is words, with no badge and no tile', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(__dirname, '..', `.workbench-run-at-menu-phone-words-${test.info().repeatEachIndex}`);
  seed(fixture);
  mkdirSync(SHOTS, { recursive: true });
  const project = await openTheBox(page, request, fixture);
  try {
    const box = page.getByTestId('composer');
    await box.fill('ask @skill about @README.md please');
    // The real file is a badge and a tile; the word is neither.
    await expect(page.getByTestId('composer-reference')).toHaveCount(1, { timeout: WAIT });
    await expect(page.getByTestId('composer-reference')).toHaveAttribute('data-reference', 'README.md');
    await expect(page.getByTestId('attachment-thumb')).toHaveCount(1);
    await expect(page.getByTestId('composer-frame').locator('.cm-content')).toContainText('@skill');
    await page.screenshot({ path: `${SHOTS}/a-word-is-words.png`, animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test.describe('on Android', () => {
  // CodeMirror reads the browser's name to take its Android input path.
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' });

  test('Backspace after a badge takes the whole reference', async ({ page, request }) => {
    test.setTimeout(180_000);
    const fixture = join(__dirname, '..', `.workbench-run-at-menu-backspace-${test.info().repeatEachIndex}`);
    seed(fixture);
    const project = await openTheBox(page, request, fixture);
    try {
      const writing = page.getByTestId('composer-frame').locator('.cm-content');
      // The Android path: the keyboard writes through an EditContext.
      expect(await writing.evaluate((box) => Boolean((box as HTMLElement & { editContext?: unknown }).editContext))).toBe(true);
      for (const reference of ['@README.md', '@skill:standup']) {
        await page.getByTestId('composer').fill(`see ${reference} now`);
        await expect(page.getByTestId('composer-reference')).toHaveCount(1, { timeout: WAIT });
        await writing.tap();
        // The caret just after the badge.
        await page.keyboard.press('End');
        for (let n = 0; n < ' now'.length; n++) await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Backspace');
        await expect(page.getByTestId('composer'), `Backspace after ${reference}`).toHaveValue('see  now');
        await expect(page.getByTestId('composer-reference')).toHaveCount(0);
        expect(await writing.evaluate((box) => box.contains(document.activeElement) || box === document.activeElement)).toBe(true);
      }
    } finally {
      await request.delete(`/api/projects/${project.id}`);
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

test.describe('with a mouse', () => {
  test.use({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false });

  test('copying a message gives back the references it was written with', async ({ page, request, context }) => {
    test.setTimeout(180_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const fixture = join(__dirname, '..', `.workbench-run-at-menu-copy-${test.info().repeatEachIndex}`);
    seed(fixture);
    mkdirSync(SHOTS, { recursive: true });
    const said = 'alpha @README.md beta @skill:standup gamma';
    const project = await openTheBox(page, request, fixture, said);
    try {
      const message = page.getByTestId('transcript').getByText('alpha', { exact: false }).first();
      await expect(message.getByTestId('mention-skill')).toBeVisible({ timeout: WAIT });
      await expect(message.locator('[data-copy="@README.md"]')).toBeAttached({ timeout: WAIT });
      const at = (await message.boundingBox())!;
      await page.mouse.move(at.x + 1, at.y + at.height / 2);
      await page.mouse.down();
      await page.mouse.move(at.x + at.width - 1, at.y + at.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.press('Control+c');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(said);

      // And the writing box copies its own references the same way.
      const line = 'one @README.md two @skill:standup three';
      await page.getByTestId('composer').fill(line);
      await expect(page.getByTestId('composer-reference')).toHaveCount(2, { timeout: WAIT });
      await page.getByTestId('composer-frame').locator('.cm-content').click();
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Control+c');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(line);
    } finally {
      await request.delete(`/api/projects/${project.id}`);
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
