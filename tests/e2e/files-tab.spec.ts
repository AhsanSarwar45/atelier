import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The Files epic, driven the way a person drives it (bw-g3o3.11).
 *
 * Every piece under this has a case of its own, and several of those cases were
 * made against a harness — the viewer mounted on its own, a chat that is only a
 * snapshot, a tree read by address rather than by clicking. What none of them
 * could prove is the SEAMS: that the tree in the rail is what opens each kind of
 * file, that a reference copied out of the viewer that the Files tab actually
 * mounts reaches the writing box in the chat beside it, and that a file named in
 * a conversation lands on the line it named. Those joints are what this file is
 * for, and it deliberately does not repeat what the cards below it already say.
 *
 * The project is a real one on the disk: a nested tree, a folder git ignores, a
 * file changed since the commit, and a picture, a video, an SVG and a Markdown
 * file. Nothing here is mocked but the agent's own words, because there is no
 * agent — the chat is a fixture snapshot, and what "sent" means is asserted
 * against the exact command the app puts on the wire.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/files-tab.spec.ts
 */

const SHOTS = 'tests/results';
const MEDIA = join(__dirname, '..', 'fixtures', 'files-preview');
const WAIT = 60_000;
const CHAT = 'files-tab-round-trip';

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

/** Ten numbered lines, so a line named in a message is readable in the picture. */
const DEEP = `${Array.from({ length: 10 }, (_, at) => `const line${at + 1} = ${at + 1};`).join('\n')}\n`;

const MARKDOWN = `# The project, read in place

The Files tab is where a path in this app opens.

- the tree on the left, one level at a time
- the file on the right, as the thing it is
`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140" viewBox="0 0 200 140">
  <rect x="10" y="10" width="180" height="120" rx="12" fill="#519aba" />
  <circle cx="100" cy="70" r="38" fill="#e37933" />
</svg>
`;

function git(at: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: at, stdio: 'pipe' });
}

/**
 * A checkout shaped like a small real project: folders inside folders, a build
 * directory git is told to ignore, a file edited since the commit, and one of
 * each kind the viewer has an opinion about.
 */
function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src', 'lib'), { recursive: true });
  mkdirSync(join(where, 'assets'), { recursive: true });
  mkdirSync(join(where, 'build'), { recursive: true });
  writeFileSync(join(where, '.gitignore'), 'build/\n');
  writeFileSync(join(where, 'README.md'), MARKDOWN);
  writeFileSync(join(where, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(join(where, 'src', 'lib', 'deep.ts'), DEEP);
  writeFileSync(join(where, 'build', 'out.js'), 'console.log(1)\n');
  writeFileSync(join(where, 'assets', 'logo.svg'), SVG);
  copyFileSync(join(MEDIA, 'shot.png'), join(where, 'assets', 'shot.png'));
  copyFileSync(join(MEDIA, 'clip.mp4'), join(where, 'assets', 'clip.mp4'));

  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'Atelier Tester');
  git(where, 'config', 'user.email', 'tester@atelier.test');
  git(where, 'config', 'commit.gpgsign', 'false');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');

  // Changed since the commit, so one name on the tree wears git's colour.
  writeFileSync(join(where, 'src', 'main.ts'), 'export const main = 2;\n');
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; path: string };
}

/** The list the app asks for holds test projects too, or the fixture is invisible. */
async function seeTestProjects(page: Page): Promise<void> {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
}

test('the tree walks a real project and opens each kind of file from the rail', async ({ page, request }) => {
  // A tree, five files, a video decode, two CodeMirror mounts and a preview.
  test.setTimeout(180_000);
  const fixture = join(__dirname, '..', '.workbench-run-files-tab-tree');
  seed(fixture);
  await seeTestProjects(page);
  const project = await fixtureProject(request, 'files-tab-tree', fixture);

  const named = (path: string) => page.locator(`[data-testid="files-tree-row"][data-path="${fixture}/${path}"]`);
  /** Click a row in the tree and wait for the viewer to be standing on it. */
  const openFromTree = async (path: string) => {
    await named(path).click({ timeout: WAIT });
    await expect
      .poll(() => page.getByTestId('files-viewer').getAttribute('data-file'), { timeout: WAIT })
      .toBe(`${fixture}/${path}`);
  };

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.goto(`/project?id=${project.id}&tab=files`);
    await page.getByTestId('files-tree').waitFor({ timeout: WAIT });
    await expect(page.getByTestId('files-tab')).toHaveAttribute('data-root', fixture, { timeout: WAIT });

    // What the first screenful says about the project without a click: what git
    // is ignoring, and what has moved since the commit.
    await expect(named('build')).toHaveAttribute('data-ignored', 'yes', { timeout: WAIT });
    await expect(named('README.md')).not.toHaveAttribute('data-ignored', 'yes');
    await expect(named('src')).toBeVisible();

    // Down two levels, a click at a time, each folder read only when it is asked
    // for: `src/lib` is drawn shut until it is opened itself.
    await named('src').click();
    await expect(named('src/main.ts')).toBeVisible({ timeout: WAIT });
    await expect
      .poll(() => named('src/main.ts').getAttribute('data-status'), { timeout: WAIT })
      .toBe('modified');
    await expect(named('src/lib')).toHaveAttribute('aria-expanded', 'false');
    await named('src/lib').click();
    await expect(named('src/lib/deep.ts')).toBeVisible({ timeout: WAIT });
    await named('assets').click();
    await expect(named('assets/shot.png')).toBeVisible({ timeout: WAIT });
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-tree.png`, animations: 'disabled' });

    // ── Each kind, opened from the rail rather than from the address ──────
    await openFromTree('src/lib/deep.ts');
    await expect(page.getByTestId('files-viewer').locator('.cm-content')).toContainText('const line1 = 1;', { timeout: WAIT });
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-text.png`, animations: 'disabled' });

    await openFromTree('README.md');
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'markdown', { timeout: WAIT });
    await expect(page.getByTestId('file-preview-markdown').locator('h1')).toHaveText('The project, read in place');
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-markdown.png`, animations: 'disabled' });

    await openFromTree('assets/logo.svg');
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'svg', { timeout: WAIT });
    await expect
      .poll(() => page.getByTestId('file-preview-image').evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: WAIT })
      .toBe(200);
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-svg.png`, animations: 'disabled' });

    await openFromTree('assets/shot.png');
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'image', { timeout: WAIT });
    await expect(page.getByTestId('file-preview-dimensions')).toHaveText('160 × 120', { timeout: WAIT });
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-image.png`, animations: 'disabled' });

    await openFromTree('assets/clip.mp4');
    await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'video', { timeout: WAIT });
    // The header really arrived over the media route: a decoder that read
    // nothing has no duration to report.
    const seconds = await page.getByTestId('file-preview-video').evaluate(
      (video: HTMLVideoElement) =>
        new Promise<number>((settle) => {
          if (video.readyState >= 1) return settle(video.duration);
          video.addEventListener('loadedmetadata', () => settle(video.duration), { once: true });
        }),
    );
    expect(seconds, 'the browser never read the video header').toBeGreaterThan(0);

    // Five files opened one after another, and the strip kept the reader's
    // place in each: only one slot is the replaceable preview.
    const strip = page.getByTestId('open-file');
    await expect(strip).toHaveCount(1);
    await expect(strip.nth(0)).toHaveAttribute('data-preview', 'true');
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-video.png`, animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('a path in a message opens the file at its line, and lines copied there go back into the chat', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const fixture = join(__dirname, '..', '.workbench-run-files-tab-chat');
  seed(fixture);
  const deep = join(fixture, 'src', 'lib', 'deep.ts');

  // The agent's words, and nothing else about the chat is invented: the path in
  // them is a real file on this disk, which is what the chip asks the server.
  const said = `The constant you are after is on ${deep}:7 — read the four lines above it too.`;
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: fixture, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: said },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];

  // The chat is a snapshot pushed over a stand-in socket, and the stand-in is
  // left reachable so the reply to what is typed below can be pushed too — a
  // sent message that never comes back is only half the round trip.
  await page.addInitScript(({ chat, view }) => {
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') !== chat) return;
        const push = (data: unknown) => this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(data) }),
        }));
        setTimeout(() => push(view), 0);
        (window as unknown as { pushChatSnapshot: (data: unknown) => void }).pushChatSnapshot = push;
      }
      close() { this.readyState = FixtureSocket.CLOSED; }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, view: foldAll(events) });

  await seeTestProjects(page);
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'claude', title: 'The round trip', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: fixture, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'The round trip', cwd: fixture, beads: [] } }));

  // Every command the app sends the agent, so what "sent" means can be asserted
  // against the bytes rather than against the screen.
  const commands: Array<{ type: string; text?: string }> = [];
  await page.route('**/api/workbench/command', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { type: string; text?: string };
    // Only the one command this case is about is answered here; everything else
    // the chat asks for is the app's own business and goes to the server.
    if (body.type !== 'prompt.send') return route.continue();
    commands.push(body);
    await route.fulfill({ json: { messageId: 'sent-1' } });
  });

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const project = await fixtureProject(request, 'files-tab-chat', fixture);

  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'The round trip' }).getByTestId('row-name').click();
    await expect(page.getByText('The constant you are after')).toBeVisible({ timeout: WAIT });

    // ── The path in the words, clicked ───────────────────────────────────
    const chip = page.getByTestId('transcript').locator('[data-path-look="badge"]').first();
    await expect(chip).toHaveAttribute('data-path-line', '7', { timeout: WAIT });
    await chip.click();

    // It landed in this app, on that file, at that line — and the address says
    // so, which is what makes it a link somebody can paste.
    await expect.poll(() => page.url(), { timeout: WAIT }).toContain('tab=files');
    expect(page.url()).toContain(`file=${encodeURIComponent(deep)}`);
    expect(page.url()).toContain('line=7');
    const viewer = page.getByTestId('files-viewer');
    await expect(viewer).toHaveAttribute('data-file', deep, { timeout: WAIT });
    await expect(viewer).toHaveAttribute('data-line', '7');
    await expect(viewer.locator('.cm-content')).toContainText('const line7 = 7;', { timeout: WAIT });
    // And the tree beside it came to meet the file, rather than leaving the
    // reader looking at a viewer with a shut rail next to it.
    await expect(page.locator(`[data-testid="files-tree-row"][data-path="${deep}"]`)).toHaveAttribute('aria-selected', 'true', { timeout: WAIT });
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-opened-at-a-line.png`, animations: 'disabled' });

    // ── Four lines picked out of the viewer the tab really mounts ─────────
    // Built through the DOM: a synthetic drag does not move the caret in this
    // headless Chromium, and dragging is the browser's business. What has to be
    // real here is the Selection and the copy fired at it.
    await page.getByTestId('file-viewer').evaluate((node) => {
      const lines = [...node.querySelectorAll('.cm-line')];
      const range = document.createRange();
      range.setStart(lines[3]!, 0);
      range.setEnd(lines[6]!, lines[6]!.childNodes.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await expect(page.getByTestId('file-copy-text')).toBeVisible({ timeout: WAIT });
    await page.evaluate(() => navigator.clipboard.writeText('nothing has been copied yet'));
    await page.keyboard.press('ControlOrMeta+c');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), {
        message: 'copying in the Files tab did not put a reference on the clipboard',
        timeout: WAIT,
      })
      .toBe('@src/lib/deep.ts:4-7');

    // ── Back to the chat, and pasted into the line he writes in ───────────
    await page.getByTestId('tab-chat').click();
    const writing = page.getByTestId('composer-frame').locator('.cm-content');
    await writing.click();
    await page.keyboard.press('ControlOrMeta+v');
    await page.keyboard.type(' — why is this repeated?');

    const badge = page.getByTestId('composer-reference');
    await expect(badge).toHaveCount(1, { timeout: WAIT });
    await expect(badge).toHaveAttribute('data-reference', 'src/lib/deep.ts:4-7');
    const typed = '@src/lib/deep.ts:4-7 — why is this repeated?';
    await expect(page.getByTestId('composer')).toHaveValue(typed);
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-pasted-into-the-composer.png`, animations: 'disabled' });

    // ── And sent: the reference reaches the agent as the characters it is ──
    await page.keyboard.press('Enter');
    await expect
      .poll(() => commands.filter((command) => command.type === 'prompt.send'), { timeout: WAIT })
      .toEqual([{ type: 'prompt.send', sessionId: CHAT, text: typed, images: [], takeover: false }]);
    await expect(page.getByTestId('composer')).toHaveValue('');

    // The agent's side of it, pushed back the way the server would have, so the
    // last picture is the conversation the reader ends up looking at.
    await page.evaluate((view) => {
      (window as unknown as { pushChatSnapshot: (data: unknown) => void }).pushChatSnapshot(view);
    }, foldAll([
      ...events,
      { ...base, seq: 6, type: 'message.started', messageId: 'asked', role: 'user' },
      { ...base, seq: 7, type: 'text.delta', messageId: 'asked', text: typed },
      { ...base, seq: 8, type: 'message.completed', messageId: 'asked' },
    ] as WbpEvent[]));
    const mine = page.getByTestId('transcript').getByText('why is this repeated?');
    await expect(mine).toBeVisible({ timeout: WAIT });
    await page.screenshot({ path: `${SHOTS}/bw-g3o311-sent.png`, animations: 'disabled' });
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
