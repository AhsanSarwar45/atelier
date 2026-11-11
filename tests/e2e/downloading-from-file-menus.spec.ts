import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test as base, chromium, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

const test = base.extend({
  browser: [async ({}, use) => {
    const browser = await chromium.connectOverCDP(process.env.CDP_URL!);
    await use(browser);
  }, { scope: 'worker' }],
  request: async ({ playwright }, use) => {
    const request = await playwright.request.newContext({ baseURL: process.env.DOWNLOAD_API_URL ?? process.env.BEADS_E2E_URL });
    await use(request);
    await request.dispose();
  },
});

// Run against an isolated app with CDP_URL from `atelier tool chrome env`.
test.skip(!process.env.CDP_URL, 'Requires private Atelier Chrome');

const SHOTS = '/tmp/bw-0albu-proof';
const WAIT = 60_000;
const CHAT = 'one-menu-vocabulary-fixture';

/**
 * Every item both menus must offer, in order.
 *
 * Written out here in the words a reader sees rather than imported from the
 * app: a test that reads the same list the menu is built from would pass on a
 * list that had quietly lost an item. `path-menu.tsx` holds the same order as
 * marks, and the unit case holds each menu to that.
 */
const VOCABULARY = [
  'path-menu-files',
  'path-menu-download',
  'path-menu-editor',
  'path-menu-reveal',
  'path-menu-terminal',
  'path-menu-copy-path',
  'path-menu-copy-relative-path',
  'path-menu-copy-reference',
  'path-new-file',
  'path-new-folder',
  'path-duplicate',
  'path-rename',
  'path-delete',
];

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

/** A checkout with one file worth naming in a chat and one worth right-clicking. */
function seed(where: string): string {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src'), { recursive: true });
  writeFileSync(join(where, 'README.md'), '# readme\n');
  writeFileSync(join(where, 'src', 'sessions.ts'), Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n'));
  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Atelier Tester');
  git(where, 'config', 'user.email', 'tester@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');
  return join(where, 'src', 'sessions.ts');
}

async function seeTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

/** The marks of every item a menu is drawing, in the order it draws them. */
async function itemsOf(menu: Locator): Promise<string[]> {
  return await menu.locator('[role="menuitem"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-testid') ?? '(unmarked)'),
  );
}

test('the tree menu and the chat menu offer the same list for the same file', async ({ page, request }) => {
  test.setTimeout(180_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-wk5u');
  const edited = seed(fixture);

  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'codex', externalId: 'fixture', model: 'gpt-5', cwd: fixture, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: `I changed ${edited}:12 for you.` },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const snapshot = foldAll(events);

  await page.addInitScript(({ chat, view }) => {
    const NativeSocket = window.WebSocket;
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (url.includes('/_next/')) return new NativeSocket(url);
        if (new URL(url).searchParams.get('chat') === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
        })), 0);
      }
      close() { this.readyState = FixtureSocket.CLOSED; }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, view: snapshot });

  await page.route('**/api/fs/exists?*', (route) => route.fulfill({ json: { exists: true } }));
  // What the app asked another program to do. Answered rather than let through:
  // a run of the cases must not open an editor on the machine it runs on.
  const opened: Array<{ path: string; target: string; line?: number | null }> = [];
  await page.route('**/api/fs/open-external', async (route) => {
    opened.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({ json: { success: true } });
  });
  const shells: Array<{ cwd?: string }> = [];
  await page.route('**/api/terminal', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: [] });
    shells.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({ json: { id: 'fixture-shell' } });
  });
  await seeTestProjects(page);
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'codex', name: 'One menu vocabulary', title: 'One menu vocabulary', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: fixture, runningElsewhere: false, held: null }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'fixture', runningElsewhere: false, held: null, name: 'One menu vocabulary', title: 'One menu vocabulary', cwd: fixture } }));

  let project: { id: string } | null = null;
  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 860 });
    project = await fixtureProject(request, 'One menu vocabulary', fixture);

    // ── the menu behind a path named in a chat ────────────────────────────
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('restore-row').first().getByTestId('row-name').click();
    const chip = page.locator('[data-path-mention]').first();
    await expect(chip).toBeVisible({ timeout: WAIT });
    await chip.click({ button: 'right' });
    const chatMenu = page.getByTestId('path-menu');
    await expect(chatMenu).toBeVisible({ timeout: WAIT });
    // The menu fades in; a picture taken mid-slide is a picture of the animation.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/bw-wk5u2-after-chat-menu.png` });
    await page.screenshot({ path: `${SHOTS}/after.png` });
    const inChat = await itemsOf(chatMenu);
    const chatDownload = page.waitForEvent('download');
    await chatMenu.getByTestId('path-menu-download').click();
    const savedChat = await chatDownload;
    expect(savedChat.suggestedFilename()).toBe('sessions.ts');
    expect(readFileSync((await savedChat.path())!)).toEqual(readFileSync(edited));
    console.log(`the chat's menu: ${JSON.stringify(inChat)}`);
    await page.keyboard.press('Escape');
    await expect(chatMenu).toHaveCount(0);

    // ── the menu behind a row of the Files tree ───────────────────────────
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await expect(page.getByTestId('files-tab')).toHaveAttribute('data-root', fixture, { timeout: WAIT });
    const row = page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/README.md"]`);
    await expect(row).toBeVisible({ timeout: WAIT });
    await row.click({ button: 'right' });
    const treeMenu = page.getByTestId('files-tree-menu');
    await expect(treeMenu).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/bw-wk5u1-after-tree-menu.png` });
    const inTree = await itemsOf(treeMenu);
    const treeDownload = page.waitForEvent('download');
    await treeMenu.getByTestId('path-menu-download').click();
    const savedTree = await treeDownload;
    expect(savedTree.suggestedFilename()).toBe('README.md');
    expect(readFileSync((await savedTree.path())!)).toEqual(readFileSync(join(fixture, 'README.md')));
    await row.click({ button: 'right' });
    console.log(`the tree's menu: ${JSON.stringify(inTree)}`);

    // ── they say the same things ──────────────────────────────────────────
    expect(inTree, 'the tree has drifted from the one vocabulary').toEqual(VOCABULARY);
    expect(inChat, 'the chat has drifted from the one vocabulary').toEqual(VOCABULARY);

    // ── and the ways out ask for the right thing ──────────────────────────
    const reopen = async () => {
      await page.keyboard.press('Escape');
      await expect(treeMenu).toBeHidden({ timeout: WAIT });
      // The library's close animation holds a layer that swallows the next press.
      await page.waitForTimeout(400);
      await row.click({ button: 'right' });
      await expect(treeMenu).toBeVisible({ timeout: WAIT });
    };

    await treeMenu.getByTestId('path-menu-editor').click();
    await expect.poll(() => opened).toEqual([{ path: `${fixture}/README.md`, target: 'vscode' }]);
    await reopen();
    await treeMenu.getByTestId('path-menu-reveal').click();
    await expect.poll(() => opened).toHaveLength(2);
    expect(opened[1]).toEqual({ path: `${fixture}/README.md`, target: 'finder' });
    await reopen();
    // A shell starts in a FOLDER, so a file is asked for by the folder it is in.
    await treeMenu.getByTestId('path-menu-terminal').click();
    await expect.poll(() => shells.map((one) => one.cwd)).toContain(fixture);
    await expect(page.getByTestId('terminal-window')).toBeVisible({ timeout: WAIT });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/bw-wk5u-terminal-from-the-tree.png` });
    console.log(`shells asked for: ${JSON.stringify(shells)}`);
    console.log(`opened outside: ${JSON.stringify(opened)}`);
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('links, binary files, empty files and the file viewer download original bytes', async ({ page, request }) => {
  test.setTimeout(120_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-downloads');
  seed(fixture);
  const names = ['sample.bin', 'empty.txt', 'large.txt'];
  const bytes = [Buffer.from([0, 255, 128, 13, 10, 0]), Buffer.alloc(0), Buffer.alloc(2 * 1024 * 1024 + 17, 97)];
  names.forEach((name, i) => writeFileSync(join(fixture, name), bytes[i]));
  writeFileSync(join(fixture, 'README.md'), '# Downloads\n\n' + names.map((name) => `[${name}](./${encodeURIComponent(name)})`).join('\n\n'));
  await seeTestProjects(page);
  const project = await fixtureProject(request, 'Downloads', fixture);
  try {
    await page.goto(`/project?id=${project.id}&tab=files&file=${encodeURIComponent(join(fixture, 'README.md'))}`);
    const preview = page.getByTestId('file-preview-markdown');
    await expect(preview).toBeVisible({ timeout: WAIT });
    for (const [index, name] of names.entries()) {
      await preview.locator(`[data-path-mention="${join(fixture, name)}"]`).click({ button: 'right' });
      const pending = page.waitForEvent('download');
      await page.getByTestId('path-menu-download').click();
      const saved = await pending;
      expect(saved.suggestedFilename()).toBe(name);
      expect(readFileSync((await saved.path())!)).toEqual(bytes[index]);
    }
    const unicodeName = 'résumé #1.bin';
    writeFileSync(join(fixture, unicodeName), bytes[0]);
    await page.locator(`[data-testid="files-tree-row"][data-path="${join(fixture, unicodeName)}"]`).click({ button: 'right' });
    const unicodeDownload = page.waitForEvent('download');
    await page.getByTestId('path-menu-download').click();
    const unicodeSaved = await unicodeDownload;
    expect(unicodeSaved.suggestedFilename()).toBe(unicodeName);
    expect(readFileSync((await unicodeSaved.path())!)).toEqual(bytes[0]);
    // Missing files stay on the page and report the refusal.
    rmSync(join(fixture, names[0]));
    await preview.locator(`[data-path-mention="${join(fixture, names[0])}"]`).click({ button: 'right' });
    await page.getByTestId('path-menu-download').click();
    await expect(page.getByText("Couldn't download file. Try again.").first()).toBeVisible();
    // A folder is not a downloadable file.
    await page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/src"]`).click({ button: 'right' });
    await expect(page.getByTestId('path-menu-download')).toHaveAttribute('data-disabled');
    await page.keyboard.press('Escape');
    const file = join(fixture, 'src', 'sessions.ts');
    await page.goto(`/project?id=${project.id}&tab=files&file=${encodeURIComponent(file)}`);
    await page.locator('.cm-content').first().click({ button: 'right' });
    const pending = page.waitForEvent('download');
    await page.getByTestId('file-viewer-menu-download').click();
    const saved = await pending;
    expect(saved.suggestedFilename()).toBe('sessions.ts');
    expect(readFileSync((await saved.path())!)).toEqual(readFileSync(file));
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
