import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';

import type { WbpEvent } from '../../src/workbench/protocol';

const CHAT = 'draft-images';
const RUN = join(__dirname, '..', '.workbench-run-draft-images');
const PICTURE = join(__dirname, '..', 'fixtures', 'files-preview', 'shot.png');
const SHOTS = join(__dirname, '..', 'results');

test.use({ viewport: { width: 1440, height: 900 } });

test('an image draft survives reload at its insertion point and picker labels close', async ({ page, request }) => {
  test.setTimeout(120_000);
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  const made = await request.post('/api/projects', { data: { name: 'draft-images', path: RUN, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: RUN, permissionMode: 'on-request' },
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
    json: { sessionId: CHAT, origin: 'app', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Draft images', cwd: RUN, beads: [] },
  }));

  try {
    await page.goto(`/project?id=${project.id}&chat=${CHAT}`);
    await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('composer').fill('before after');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.getByTestId('image-input').setInputFiles(PICTURE);

    const badge = page.getByTestId('composer-image-badge');
    await expect(badge).toHaveText('shot.png');
    await expect(page.getByTestId('attachment-thumb')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('composer-image-badge')).toHaveText('shot.png', { timeout: 60_000 });
    await expect(page.getByTestId('attachment-thumb')).toBeVisible();
    await page.getByTestId('composer-image-badge').click();
    await expect(page.getByTestId('picture-viewer')).toBeVisible();
    await page.keyboard.press('Escape');

    const picker = page.getByTestId('mode-picker');
    await picker.hover();
    await expect(page.getByRole('tooltip')).toContainText('Permission mode');
    await picker.click();
    await page.getByTestId('mode-picker-option').last().click();
    await expect(page.getByRole('tooltip')).toHaveCount(0);

    await page.screenshot({ path: join(SHOTS, 'bw-0vm1-after.png'), animations: 'disabled' });

    await page.getByTestId('attachment-remove').click();
    await expect(page.getByTestId('composer-image-badge')).toHaveCount(0);
    await expect(page.getByTestId('attachment-thumb')).toHaveCount(0);

    await page.locator('.cm-content').click();
    await page.keyboard.press('End');
    await page.getByTestId('image-input').setInputFiles(PICTURE);
    await expect(page.getByTestId('composer-image-badge')).toHaveCount(1);
    await page.locator('.cm-content').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('composer-image-badge')).toHaveCount(0);
    await expect(page.getByTestId('attachment-thumb')).toHaveCount(0);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(RUN, { recursive: true, force: true });
  }
});
