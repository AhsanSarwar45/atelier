import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { ruledPng } from './fixture-png';

/**
 * A picture opened from a chat is drawn fully opaque at once, however soon it
 * is touched (bw-ux93q).
 *
 * The viewer used to fade in. A wheel or click during that fade often left the
 * picture stuck half transparent. The viewer no longer fades, so this case
 * opens it, works it at once, and checks that nothing on it is animating and
 * that the window and the dim behind it are at full opacity.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-picture-opens-fully-drawn.spec.ts
 */

const SHOTS = join(__dirname, '..', 'results');
const FIXTURE = join(__dirname, '..', '.workbench-run-opens-drawn');
const WAIT = 60_000;

test.setTimeout(120_000);

function recordDir(projectPath: string): string {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(config, 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
}

function aChatWithAPicture(projectPath: string) {
  const id = randomUUID();
  const dir = recordDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const line = (parent: string | null, type: 'user' | 'assistant', content: unknown) => {
    const uuid = randomUUID();
    return {
      uuid,
      text: JSON.stringify({
        parentUuid: parent, isSidechain: false, type,
        message: { role: type, content },
        uuid, timestamp: new Date().toISOString(), userType: 'external', entrypoint: 'cli',
        cwd: projectPath, sessionId: id, version: '2.1.232',
      }),
    };
  };
  const asked = line(null, 'user', [
    { type: 'text', text: 'look at this grid [Image #1]' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ruledPng(1600, 1200).toString('base64') } },
  ]);
  const answered = line(asked.uuid, 'assistant', [{ type: 'text', text: 'A ruled grid.' }]);
  writeFileSync(file, `${asked.text}\n${answered.text}\n`);
  return { id, forget: () => rmSync(file, { force: true }) };
}

/** What is still moving on the viewer, and how opaque its window and dim are. */
async function drawnState(page: Page) {
  return page.evaluate(() => {
    const viewer = document.querySelector('[data-testid="picture-viewer"]') as HTMLElement;
    const overlay = viewer.previousElementSibling as HTMLElement;
    return {
      running: [viewer, overlay].flatMap((el) => el.getAnimations()).length,
      viewer: getComputedStyle(viewer).opacity,
      overlay: getComputedStyle(overlay).opacity,
    };
  });
}

test('a picture opened from a chat is fully drawn however soon it is touched', async ({ page, request }) => {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });

  const made = await request.post('/api/projects', { data: { name: 'opens-drawn', path: FIXTURE, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };
  const chat = aChatWithAPicture(FIXTURE);
  try {
    const opened = await request.post('/api/workbench/command', {
      data: { type: 'session.open', externalId: chat.id, brand: 'claude', projectId: project.id, projectPath: FIXTURE },
    });
    expect(opened.status(), await opened.text()).toBe(200);
    const sessionId = ((await opened.json()) as { id: string }).id;

    await page.goto(`/project?id=${project.id}&chat=${sessionId}`);
    const thumbnail = page.getByTestId('user-message').getByTestId('message-image').first();
    await expect(thumbnail).toBeVisible({ timeout: WAIT });

    for (let round = 0; round < 5; round += 1) {
      await thumbnail.click();
      const viewer = page.getByTestId('picture-viewer');
      await expect(viewer).toBeVisible();
      // Straight away, inside what used to be the fade.
      expect(await drawnState(page)).toEqual({ running: 0, viewer: '1', overlay: '1' });
      const box = (await page.getByTestId('picture-zoom-viewport').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -200);
      await page.mouse.dblclick(box.x + box.width / 3, box.y + box.height / 3);
      expect(await drawnState(page)).toEqual({ running: 0, viewer: '1', overlay: '1' });
      if (round === 0) await page.screenshot({ path: join(SHOTS, 'picture-opens-fully-drawn.png') });
      await page.keyboard.press('Escape');
      await expect(viewer).toHaveCount(0);
    }
  } finally {
    chat.forget();
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
