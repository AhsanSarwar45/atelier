import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * A tap on a popup stays on the popup.
 *
 * On a phone, tapping a line of the `@` menu inserted the reference and also
 * pressed whatever was drawn behind the menu: the sidebar button, a message.
 * The menu picked on the finger's lift and closed, and the click the browser
 * sends after a tap then landed on what was under the finger by then. A tap
 * outside an open popover did the same: it closed the popover and pressed the
 * thing behind it as well.
 *
 * Each case records every click that reaches the page outside the popup.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/a-tap-on-a-popup-stays-on-it.spec.ts
 */

const SHOTS = 'tests/results/a-tap-on-a-popup-stays-on-it';
const WAIT = 60_000;
const CHAT = 'tap-on-a-popup-chat';
const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

// One project per test, so the tests can run side by side.
let fixture = '';
let project: { id: string } | undefined;

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(join(where, 'src'), { recursive: true });
  writeFileSync(join(where, 'README.md'), '# Tapped on a phone\n');
  writeFileSync(join(where, 'src', 'main.ts'), 'export const main = 1;\n');
}

async function fixtureProject(request: APIRequestContext, name: string) {
  const made = await request.post('/api/projects', { data: { name, path: fixture, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

/** Open the fixture chat, with a recorder of every click outside a popup. */
async function openChat(page: Page): Promise<void> {
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'opus', cwd: fixture, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text: 'An answer behind the menus.\n\n'.repeat(30) },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
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
        const push = (data: unknown) =>
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(data) }),
            }),
          );
        setTimeout(() => push(view), 0);
      }
      close() {
        this.readyState = FixtureSocket.CLOSED;
      }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });

    // Capture on the root element, so a click the app swallows on the window
    // never reaches it, and one the app lets through is seen before any
    // handler can stop it.
    const strays: string[] = [];
    (window as unknown as { strays: string[] }).strays = strays;
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.addEventListener(
        'click',
        (event) => {
          const target = event.target as Element | null;
          // A click on the bare page presses nothing: it is where a tap
          // outside a modal popup lands while the page behind takes none.
          if (!target || target === document.documentElement || target === document.body) return;
          if (target.closest('.cm-tooltip, [data-radix-popper-content-wrapper]')) return;
          const named = target.closest('[data-testid], [aria-label]');
          strays.push(named?.getAttribute('data-testid') ?? named?.getAttribute('aria-label') ?? target.tagName);
        },
        true,
      );
    });
  }, { chat: CHAT, view: foldAll(events) });

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) =>
    route.fulfill({
      json: {
        sessionId: CHAT,
        origin: 'terminal',
        brand: 'claude',
        externalId: 'fixture',
        runningElsewhere: false,
        held: null,
        title: 'A chat tapped on a phone',
        cwd: fixture,
      },
    }),
  );
  await page.goto(`/project?id=${project!.id}&tab=chat&chat=${CHAT}`);
  await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
  await page.waitForTimeout(1000);
}

async function strays(page: Page): Promise<string[]> {
  // The click after a tap comes a moment after the lift.
  await page.waitForTimeout(600);
  return page.evaluate(() => (window as unknown as { strays: string[] }).strays.splice(0));
}

async function tap(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<void> {
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test.beforeEach(async ({ request }, info) => {
  const name = `tap-on-a-popup-${info.workerIndex}`;
  fixture = join(__dirname, '..', `.workbench-run-${name}`);
  seed(fixture);
  project = await fixtureProject(request, name);
  mkdirSync(SHOTS, { recursive: true });
});

test.afterEach(async ({ request }) => {
  if (project) await request.delete(`/api/projects/${project.id}`).catch(() => undefined);
  rmSync(fixture, { recursive: true, force: true });
});

test('a tap on a line of the @ menu inserts it and presses nothing behind the menu', async ({ page }) => {
  await openChat(page);
  const writing = page.getByTestId('composer-frame').locator('.cm-content');
  await writing.click();
  await page.keyboard.type('@READ');
  const line = page.locator('.cm-tooltip-autocomplete li[id]').first();
  await expect(line).toBeVisible({ timeout: WAIT });
  await page.screenshot({ path: `${SHOTS}/01-at-menu.png` });
  await strays(page);

  await tap(page, (await line.boundingBox())!);
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
  await expect(writing).toContainText('README.md');
  expect(await strays(page), 'clicks that reached the page behind the @ menu').toEqual([]);
});

test('a tap on a menu item picks it and presses nothing behind the menu', async ({ page }) => {
  await openChat(page);
  await page.getByTestId('chat-more-tools').tap();
  const item = page.getByRole('menuitem', { name: 'Message kinds' });
  await expect(item).toBeVisible();
  await strays(page);

  await tap(page, (await item.boundingBox())!);
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(await strays(page), 'clicks that reached the page behind the menu').toEqual([]);
});

test('the panel a menu item opens stays open', async ({ page }) => {
  await openChat(page);
  await page.getByTestId('chat-more-tools').tap();
  await page.getByRole('menuitem', { name: 'Message kinds' }).tap();
  await page.waitForTimeout(600);
  await expect(page.getByTestId('kind-filter-panel'), 'the panel the item opened closed by itself').toBeVisible();
});

test.describe('on a tablet', () => {
  // Wide enough that the message kinds filter has its own button.
  test.use({ viewport: { width: 1024, height: 768 } });

  test('a tap outside an open popover closes it and presses nothing behind it', async ({ page }) => {
    await openChat(page);
    await page.getByTestId('open-kind-filter').tap();
    const panel = page.getByTestId('kind-filter-panel');
    await expect(panel).toBeVisible();
    await strays(page);

    // The chat below the panel: what a thumb lands on when it taps away.
    const transcript = (await page.getByTestId('transcript').boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    const y = transcript.y + transcript.height - 60;
    expect(y, 'the panel covers the whole chat').toBeGreaterThan(panelBox.y + panelBox.height);
    await page.screenshot({ path: `${SHOTS}/02-popover.png` });
    await page.touchscreen.tap(transcript.x + transcript.width / 2, y);
    await expect(panel).toHaveCount(0);
    expect(await strays(page), 'clicks that reached the page behind the popover').toEqual([]);
  });
});
