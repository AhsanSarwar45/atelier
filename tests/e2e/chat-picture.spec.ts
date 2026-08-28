import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { quadrantPng } from './fixture-png';

/**
 * A picture in a chat's own record is a picture on the screen.
 *
 * What the manager was looking at on 2026-08-20 was his own message coming back
 * as the bare words `[Image #1]` — the marker the harness writes where a
 * picture was pasted — with nothing behind it and nothing to click. The record
 * held the picture the whole time, in a block of its own beside the words; the
 * reading threw it away (bw-uu9x).
 *
 * A real chat cannot be told to hold a picture on cue, so the chat here is
 * written rather than waited for: a record in the shape the tool writes and the
 * kit reads back, under a fixture project of this run's own. That is the same
 * ground the live-chat cases stand on (tests/e2e/chat-live.spec.ts), and it is
 * the only thing the app and the tool that wrote the record share.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/chat-picture.spec.ts
 */

/** Kept out of Playwright's outputDir, which is wiped at the start of a run. */
const FIXTURE = join(__dirname, '..', '.workbench-run-picture');
/** A project of its own, so the two cases never share a chat list. */
const MANY = join(__dirname, '..', '.workbench-run-pictures');
const SHOTS = join(__dirname, '..', 'results');

/** Where the sidecar under test reads its records, as it works it out itself. */
function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Where a project's records live, named the way the tool names them: the path
 * with everything that is not a letter or a digit turned into a dash.
 */
function recordDir(projectPath: string): string {
  return join(configDir(), 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** One line of a record, in the shape the tool writes and the kit reads back. */
function row(chat: { id: string; cwd: string }, parent: string | null, type: 'user' | 'assistant', content: unknown) {
  const uuid = randomUUID();
  return {
    uuid,
    text: JSON.stringify({
      parentUuid: parent,
      isSidechain: false,
      type,
      message: { role: type, content },
      uuid,
      timestamp: new Date().toISOString(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: chat.cwd,
      sessionId: chat.id,
      version: '2.1.232',
    }),
  };
}

/** The words the harness leaves behind where the picture was pasted. */
const ASKED = 'look at this and tell me what is wrong';
const ANSWERED = 'Four quadrants: red, blue, green and yellow.';

/** One picture block, the way the tool writes a pasted picture down. */
function picture(size = 120) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: quadrantPng(size).toString('base64') },
  };
}

/**
 * A chat somebody pasted pictures into, written down the way the tool writes
 * one: the words carrying the markers, and each picture in a block of its own.
 */
function aChatWithPicturesIn(projectPath: string, count = 1) {
  const chat = { id: randomUUID(), cwd: projectPath };
  const dir = recordDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${chat.id}.jsonl`);
  const proof = join(projectPath, 'agent-files-screen.png');
  writeFileSync(proof, quadrantPng(240));
  const markers = Array.from({ length: count }, (_, i) => `[Image #${i + 1}]`).join(' ');
  const asked = row(chat, null, 'user', [
    { type: 'text', text: `${ASKED} ${markers}` },
    // Sizes differ so the grid is proved to line them up rather than merely
    // inheriting one shape from the pictures themselves.
    ...Array.from({ length: count }, (_, i) => picture(120 + i * 40)),
  ]);
  const answered = row(chat, asked.uuid, 'assistant', [{
    type: 'text',
    text: `${ANSWERED}\n\n![Agent files desktop screen](<${proof}>)`,
  }]);
  writeFileSync(file, `${asked.text}\n${answered.text}\n`);
  return { ...chat, forget: () => rmSync(file, { force: true }) };
}

/** A fixture project, marked `isTest` so it stays off the owner's dashboard. */
async function projectAt(request: APIRequestContext, path: string): Promise<{ id: string }> {
  const existing = (await (await request.get('/api/projects?include_test=true')).json()) as {
    id: string;
    path: string;
  }[];
  const found = existing.find((p) => p.path === path);
  if (found) return found;
  const created = await request.post('/api/projects', {
    data: { name: 'workbench-picture', path, isTest: true },
  });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json()) as { id: string };
}

test.describe('a picture in a chat that already happened', () => {
  /**
   * A fixture project is `isTest`, which keeps it off the owner's dashboard —
   * and, with nothing else said, off its own browser tab as well, because the
   * page resolves a project by filtering the plain list. So this page asks for
   * test projects too (as tests/e2e/workbench.spec.ts does).
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const url = new URL(route.request().url());
      url.searchParams.set('include_test', 'true');
      await route.continue({ url: url.toString() });
    });
  });

  test('draws the picture, drops the marker, and opens it full size', async ({ page, request }) => {
    test.setTimeout(180_000);

    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
    mkdirSync(SHOTS, { recursive: true });

    const project = await projectAt(request, FIXTURE);
    const chat = aChatWithPicturesIn(FIXTURE);
    let sessionId = '';

    try {
      const opened = await request.post('/api/workbench/command', {
        data: {
          type: 'session.open',
          externalId: chat.id,
          brand: 'claude',
          projectId: project.id,
          projectPath: FIXTURE,
        },
      });
      expect(opened.status(), await opened.text()).toBe(200);
      sessionId = ((await opened.json()) as { id: string }).id;

      await page.goto(`/project?id=${project.id}&chat=${sessionId}`);
      await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 60_000 });

      // The chat is the right one: what was said in it is here.
      await expect(page.getByTestId('transcript').getByText(ANSWERED)).toBeVisible({ timeout: 60_000 });

      // 1. The picture is drawn, in the bubble of the message it was pasted into.
      const thumbnail = page.getByTestId('user-message').getByTestId('message-image').first();
      await expect(thumbnail, 'the picture in the record was not drawn').toBeVisible({ timeout: 60_000 });
      await expect(thumbnail).toHaveJSProperty('naturalWidth', 120);

      // An agent's Markdown image names a host file. The browser receives it
      // through the guarded media route instead of drawing only its alt label.
      const markdownPicture = page.getByTestId('markdown-local-image');
      await expect(markdownPicture).toBeVisible();
      await expect(markdownPicture).toHaveJSProperty('naturalWidth', 240);
      await page.screenshot({ path: join(SHOTS, 'chat-local-markdown-image.png'), fullPage: false });

      // 2. The marker the harness wrote is gone, and the words around it stand.
      await expect(page.getByTestId('user-message').first()).toContainText(ASKED);
      const markers = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="user-message"],[data-testid="assistant-message"]')]
          .map((el) => el.textContent ?? '')
          .filter((t) => t.includes('[Image #')),
      );
      expect(markers, 'a message still carries the harness’s picture marker').toEqual([]);

      // 3. Clicking it opens it over the chat, at full size.
      await thumbnail.click();
      await expect(page.getByTestId('picture-viewer')).toBeVisible();
      await expect(page.getByTestId('picture-viewer-image')).toBeVisible();
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await expect(page.getByTestId('picture-transform')).toHaveAttribute('data-scale', '2');
      const viewport = page.getByTestId('picture-zoom-viewport');
      const box = await viewport.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + box!.height / 2 + 60);
      await page.mouse.up();
      await expect(page.getByTestId('picture-transform')).toHaveAttribute('data-pan-x', '100');
      await expect(page.getByTestId('picture-transform')).toHaveAttribute('data-pan-y', '60');
      await page.screenshot({ path: join(SHOTS, 'chat-picture-zoomed.png'), fullPage: false });

      // And it closes again, so the chat is not left behind a sheet.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('picture-viewer')).toHaveCount(0);
    } finally {
      if (sessionId) {
        await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId } });
      }
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
      rmSync(FIXTURE, { recursive: true, force: true });
    }
  });

  /**
   * Five pictures are three across and then two, and the block stays a block.
   *
   * Stacked at full bubble width — which is what they were — two screenshots
   * pushed the words off the screen and five were a page of their own
   * (bw-uu9x.10). A browser with no layout can only be told the rule; where the
   * thumbnails actually land is a question for the glass, so it is asked here:
   * the drawn positions are read off the running page and counted into rows.
   */
  test('lays five pictures out three then two, inside a bounded block', async ({ page, request }) => {
    test.setTimeout(180_000);

    rmSync(MANY, { recursive: true, force: true });
    mkdirSync(MANY, { recursive: true });
    mkdirSync(SHOTS, { recursive: true });

    const project = await projectAt(request, MANY);
    const chat = aChatWithPicturesIn(MANY, 5);
    let sessionId = '';

    try {
      const opened = await request.post('/api/workbench/command', {
        data: {
          type: 'session.open',
          externalId: chat.id,
          brand: 'claude',
          projectId: project.id,
          projectPath: MANY,
        },
      });
      expect(opened.status(), await opened.text()).toBe(200);
      sessionId = ((await opened.json()) as { id: string }).id;

      await page.goto(`/project?id=${project.id}&chat=${sessionId}`);
      await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('transcript').getByText(ANSWERED)).toBeVisible({ timeout: 60_000 });

      const grid = page.getByTestId('user-message').getByTestId('picture-grid').first();
      await expect(grid).toBeVisible({ timeout: 60_000 });
      const thumbs = page.getByTestId('user-message').getByTestId('message-image');
      await expect(thumbs).toHaveCount(5);

      // 1. Where they landed: three on one line, two on the next.
      const boxes = await thumbs.evaluateAll((els) =>
        els.map((el) => {
          const box = el.getBoundingClientRect();
          return { top: Math.round(box.top), height: box.height, width: box.width };
        }),
      );
      const rows = new Map<number, number>();
      for (const box of boxes) rows.set(box.top, (rows.get(box.top) ?? 0) + 1);
      expect([...rows.values()], 'five pictures did not land three then two').toEqual([3, 2]);

      // 2. The block is a block: bounded, and not a screenshot the size of the page.
      const width = await grid.evaluate((el) => el.getBoundingClientRect().width);
      expect(width, 'the block of pictures is wider than its cap').toBeLessThanOrEqual(400);
      for (const box of boxes) expect(box.height).toBeLessThanOrEqual(200);

      // 3. Every one of them still opens whole — including the last.
      await thumbs.last().click();
      await expect(page.getByTestId('picture-viewer')).toBeVisible();
      await expect(page.getByTestId('picture-viewer-image')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('picture-viewer')).toHaveCount(0);
      await page.screenshot({ path: join(SHOTS, 'chat-picture-grid.png'), fullPage: false });
    } finally {
      if (sessionId) {
        await request.post('/api/workbench/command', { data: { type: 'session.stop', sessionId } });
      }
      chat.forget();
      await request.delete(`/api/projects/${project.id}`);
      rmSync(MANY, { recursive: true, force: true });
    }
  });
});
