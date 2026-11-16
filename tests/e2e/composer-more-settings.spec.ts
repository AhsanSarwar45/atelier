import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The composer row keeps the settings changed most often — permission mode,
 * auto-approve, account, model and effort — and puts the rest behind a "More
 * settings" button, so a chat with every control a provider offers still fits.
 *
 * Run: scripts/checks/composer-e2e.sh tests/e2e/composer-more-settings.spec.ts
 */

const WAIT = 60_000;
const LONG_NAME = 'A provider setting with a very long name that keeps going';

function git(at: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: at, stdio: 'pipe' });
}

function seed(where: string): void {
  rmSync(where, { recursive: true, force: true });
  mkdirSync(where, { recursive: true });
  writeFileSync(join(where, 'README.md'), '# More settings\n');
  git(where, 'init', '-q', '-b', 'main', '.');
  git(where, 'config', 'user.name', 'More Settings');
  git(where, 'config', 'user.email', 'more-settings@atelier.test');
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', 'seed');
}

function events(chat: string, cwd: string, autoApprove: boolean): WbpEvent[] {
  const base = { sessionId: chat, at: new Date(0).toISOString() };
  return [
    { ...base, seq: 1, type: 'session.started', brand: 'claude', externalId: 'fixture', model: 'claude-opus-5', cwd, permissionMode: 'default', autoApprove },
    {
      ...base,
      seq: 2,
      type: 'session.menu',
      commands: [],
      skills: [],
      models: [
        { value: 'claude-opus-5', displayName: 'Opus 5', group: 'alias' },
        { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', group: 'alias' },
      ],
      permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
      collaborationModes: [
        { value: 'default', displayName: 'Default' },
        { value: 'plan', displayName: 'Plan' },
      ],
      efforts: [
        { value: 'low', displayName: 'Low' },
        { value: 'medium', displayName: 'Medium' },
      ],
      agentDefinitions: [],
      configOptions: [
        { id: 'fast', name: 'Fast mode', type: 'boolean', currentValue: false },
        { id: 'long', name: LONG_NAME, type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'Default' }, { value: 'b', name: 'Other' }] },
      ],
      agentControls: ['stop'],
    },
    { ...base, seq: 3, type: 'session.state', state: 'idle', label: 'Ready' },
  ] as WbpEvent[];
}

async function fixtureProject(request: APIRequestContext, name: string, path: string) {
  const made = await request.post('/api/projects', { data: { name, path, isTest: true } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string };
}

/** Opens a chat drawn from `events`, with no live agent behind it. */
async function openChat(page: Page, request: APIRequestContext, { autoApprove = false, width = 1440 } = {}) {
  // One chat and fixture folder per test: the tests run side by side.
  const chat = `more-settings-${autoApprove ? 'on' : 'off'}-${width}-${test.info().testId}`;
  const fixture = join(__dirname, '..', `.workbench-run-${chat}`);
  seed(fixture);
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
  }, { chat, view: foldAll(events(chat, fixture, autoApprove)) });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(new RegExp(`/api/workbench/session/${chat}$`), (route) => route.fulfill({
    json: { sessionId: chat, origin: 'terminal', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'More settings', cwd: fixture },
  }));
  const project = await fixtureProject(request, chat, fixture);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/project?id=${project.id}&tab=chat&chat=${chat}`);
  await expect(page.getByTestId('transcript')).toBeVisible({ timeout: WAIT });
  await expect(page.locator('[data-testid="model-picker"]:visible, [data-testid="mobile-composer-settings"]:visible').first()).toBeVisible({ timeout: WAIT });
  return async () => {
    await request.delete(`/api/projects/${project.id}`).catch(() => {});
    rmSync(fixture, { recursive: true, force: true });
  };
}

const PRIMARY = ['mode-picker', 'auto-approve-picker', 'model-picker', 'effort-picker'];
const SECONDARY = ['workers-picker', 'collaboration-mode-picker', 'config-fast-picker', 'config-long-picker'];

test('the row keeps mode, auto-approve, model and effort and nothing else', async ({ page, request }) => {
  test.setTimeout(180_000);
  const done = await openChat(page, request);
  try {
    const row = page.getByTestId('desktop-composer-settings');
    for (const id of PRIMARY) await expect(row.getByTestId(id)).toBeVisible();
    const onRow: string[] = [];
    for (const id of SECONDARY) if (await row.getByTestId(id).isVisible()) onRow.push(id);
    expect(onRow, 'secondary settings still on the composer row').toEqual([]);
  } finally {
    await done();
  }
});

test('more settings holds the rest and their menus open', async ({ page, request }) => {
  test.setTimeout(180_000);
  const done = await openChat(page, request);
  try {
    await page.getByRole('button', { name: 'More settings' }).click();
    const menu = page.getByTestId('more-composer-settings');
    for (const id of SECONDARY) await expect(menu.getByTestId(id)).toBeVisible();
    await menu.evaluate((element) => Promise.all(element.getAnimations().map((one) => one.finished)));
    await page.screenshot({ path: 'tests/results/composer-more-settings/after-1440-panel.png' });
    await menu.getByTestId('collaboration-mode-picker').click();
    await expect(page.getByTestId('collaboration-mode-picker-menu')).toBeVisible();
    await expect(page.getByTestId('collaboration-mode-picker-option')).toHaveCount(2);
    // Opening a setting's own list leaves the More settings panel open behind it.
    await expect(menu).toBeVisible();
  } finally {
    await done();
  }
});

test('more settings by keyboard', async ({ page, request }) => {
  test.setTimeout(180_000);
  const done = await openChat(page, request);
  try {
    const button = page.getByRole('button', { name: 'More settings' });
    await button.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByTestId('more-composer-settings');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('workers-picker')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('workers-picker-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('workers-picker-menu')).toBeHidden();
    await page.keyboard.press('Tab');
    await expect(menu.getByTestId('collaboration-mode-picker')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();
  } finally {
    await done();
  }
});

test('a long setting name stays inside the more settings panel', async ({ page, request }) => {
  test.setTimeout(180_000);
  const done = await openChat(page, request);
  try {
    await page.getByRole('button', { name: 'More settings' }).click();
    const menu = page.getByTestId('more-composer-settings');
    await expect(menu.getByTestId('config-long-picker')).toBeVisible();
    const box = await menu.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, right: el.getBoundingClientRect().right }));
    expect(box.scroll, 'the panel scrolls sideways').toBeLessThanOrEqual(box.client + 1);
    expect(box.right, 'the panel runs off the window').toBeLessThanOrEqual(1440);
  } finally {
    await done();
  }
});

test('a phone keeps every setting in the chat settings dialog', async ({ page, request }) => {
  test.setTimeout(180_000);
  const done = await openChat(page, request, { width: 390 });
  try {
    await expect(page.getByRole('button', { name: 'More settings' })).toBeHidden();
    await page.getByTestId('mobile-composer-settings').click();
    const dialog = page.getByTestId('mobile-composer-settings-dialog');
    for (const id of [...PRIMARY, ...SECONDARY]) {
      await expect(dialog.getByTestId(`mobile-${id}`)).toBeVisible();
    }
  } finally {
    await done();
  }
});
