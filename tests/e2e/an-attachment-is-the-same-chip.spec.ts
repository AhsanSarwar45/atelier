import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { foldAll } from '../../src/workbench/fold';

import type { WbpEvent } from '../../src/workbench/protocol';

/**
 * The attachment's chip is the app's one chip, at one height (bw-e9p5).
 *
 * The owner photographed the writing box on a phone: the chip naming an
 * attached picture stood roughly twice the height of the same chip on a
 * desktop, and the cross on the thumbnail beside it was bigger than the corner
 * of the picture it sat on. Both had one cause. The chip was built by hand in
 * the CodeMirror widget rather than from `Badge` — it borrowed the recipe but
 * not the component — so it went out without `data-slot="badge"`, and the
 * coarse-pointer floor in `globals.css` exempts chips by exactly that
 * attribute. With a mouse it kept its drawn 20px; under a thumb it was forced
 * to 44.
 *
 * So the measurement is the whole case: the SAME chip is measured on a desktop
 * and on a phone, and the two numbers have to agree. A test that only looked at
 * the phone would pass against a chip that had been shrunk everywhere.
 *
 * Run: scripts/workbench-e2e.sh tests/e2e/an-attachment-is-the-same-chip.spec.ts
 */

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 900 };
const WAIT = 60_000;

const SHOTS = join(process.cwd(), 'tests', 'results', 'an-attachment-is-the-same-chip');
const PICTURE = join(__dirname, '..', 'fixtures', 'files-preview', 'shot.png');

const CHAT = 'an-attachment-is-the-same-chip';
const FIXTURE = join(process.cwd(), 'tests', `.workbench-run-${CHAT}`);

test.describe.configure({ mode: 'serial' });

/** What a control really occupies on the screen. */
async function measured(page: Page, testid: string) {
  return page.getByTestId(testid).evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height) };
  });
}

/** The chat, the project and the picture: the same opening both sizes need. */
async function openWithAPictureAttached(page: Page, request: { post: Function; get: Function }): Promise<void> {
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(join(FIXTURE, 'keep'), '');

  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });

  // Both sizes open the same project: the second run finds it already on the
  // home screen, which is a 409 and not a failure.
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
    json: { sessionId: CHAT, origin: 'app', brand: 'claude', externalId: 'fixture', runningElsewhere: false, held: null, title: 'An attachment is the same chip', cwd: FIXTURE, beads: [] },
  }));

  await page.goto(`/project?id=${project.id}&chat=${CHAT}`);
  await expect(page.getByTestId('chat-tab')).toBeVisible({ timeout: WAIT });
  await expect(page.getByTestId('composer-frame')).toBeVisible({ timeout: WAIT });

  const chooser = page.waitForEvent('filechooser', { timeout: WAIT });
  await page.getByTestId('attach-picture').click();
  await (await chooser).setFiles(PICTURE);

  await expect(page.getByTestId('attachment-tray')).toBeVisible({ timeout: WAIT });
  await expect(page.getByTestId('composer-image-badge')).toHaveText('shot.png', { timeout: WAIT });
}

async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
}

/** Filled by the desktop run and read by the phone's, which is why serial. */
const onADesktop: { chip?: number } = {};

test.describe('with a mouse', () => {
  test.use({ viewport: DESK, deviceScaleFactor: 2 });

  test('the chip names the picture, wearing its file kind', async ({ page, request }) => {
    test.setTimeout(180_000);
    await openWithAPictureAttached(page, request);

    const badge = page.getByTestId('composer-image-badge');

    // The one chip, and demonstrably so: `data-slot` is what the rest of the
    // app and every rule in globals.css recognise a chip BY, and its absence
    // is the whole of the fault this case fixed.
    await expect(badge).toHaveAttribute('data-slot', 'badge');

    // And it carries the kind of thing it names, the way a path chip does:
    // `shot.png` is a picture, so it wears the picture icon and colour.
    await expect(badge).toHaveAttribute('data-file-kind', 'image');
    expect(await badge.locator('svg').count(), 'the chip draws its file type').toBe(1);

    onADesktop.chip = (await measured(page, 'composer-image-badge')).height;
    await shoot(page, '01-with-a-mouse');
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

  test('the same chip is the same height, and the cross stays inside the picture', async ({ page, request }) => {
    test.setTimeout(180_000);
    await openWithAPictureAttached(page, request);

    const chip = await measured(page, 'composer-image-badge');
    expect(onADesktop.chip, 'the desktop run measured first').toBeGreaterThan(0);
    expect(
      chip.height,
      `the chip stood ${chip.height}px under a thumb and ${onADesktop.chip}px under a mouse; it is one chip and has one height`,
    ).toBe(onADesktop.chip);

    // The cross is drawn over the corner of the thumbnail. Bigger than the
    // thumbnail's own edge and it stops being a cross ON a picture and starts
    // being the picture's only answer to a press.
    const cross = await measured(page, 'attachment-remove');
    const thumb = await measured(page, 'attachment-thumb');
    expect(cross.height, `the cross measured ${cross.height}px`).toBeLessThanOrEqual(24);
    expect(cross.width).toBeLessThanOrEqual(24);
    expect(
      cross.height,
      `a ${cross.height}px cross on a ${thumb.height}px picture`,
    ).toBeLessThan(thumb.height / 2);

    // And the picture is still the thing a press finds: the cross may not have
    // grown an invisible band over the thumbnail it sits on.
    const opens = await page.getByTestId('attachment-thumb').evaluate((el) => {
      const box = el.getBoundingClientRect();
      const on = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return Boolean(on && (on === el || el.contains(on)));
    });
    expect(opens, 'the middle of the thumbnail still opens the picture').toBe(true);

    await shoot(page, '02-on-a-phone');
  });
});
