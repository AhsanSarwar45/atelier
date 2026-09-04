import { expect, test } from '@playwright/test';

import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import { discardFixture, makeFixtureProject } from './fixture-board';

const CHAT = 'site-badge-mark-fixture';

/**
 * The badge asks each site for `/favicon.ico`, and this browser will not send
 * that request: the driver marks any URL ending in `/favicon.ico` as a favicon
 * request of the browser's own and fails it without ever offering it to a
 * test's routing (`_isFavicon` in playwright-core). Every mark would therefore
 * be missing here and the case would prove only the globe. So the page's own
 * image elements are asked for the same file under a name the driver will
 * carry, and the badge is otherwise untouched: it still fetches on its own,
 * still learns from `load` and `error`, and still decides what to draw.
 */
const CARRIED = '?carried-by-the-driver=1';

/** A mark no globe could be mistaken for: a filled square with a white eye. */
function markPng(red: number, green: number, blue: number): Buffer {
  const size = 16;
  const rows: number[] = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(0);
    for (let x = 0; x < size; x += 1) {
      const eye = (x - 8) ** 2 + (y - 8) ** 2 < 12;
      rows.push(...(eye ? [255, 255, 255] : [red, green, blue]));
    }
  }
  const crc32 = (buf: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buf) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const MARKS: Record<string, Buffer> = {
  'qwen.example.org': markPng(0xe1, 0x1d, 0x48),
  'gemma.example.net': markPng(0x22, 0x8b, 0x22),
  'liquid.example.com': markPng(0x1d, 0x4e, 0xd8),
};

test('a site with a mark of its own draws the mark in the globe\'s place', async ({ page, request }) => {
  await page.setViewportSize({ width: 900, height: 520 });
  const run = join(process.cwd(), 'tests', '.workbench-run-site-badge');
  const projectPath = makeFixtureProject(join(run, 'project'), join(run, 'reporting'));
  const text = [
    'Sources:',
    '',
    '- [Qwen 3.8 model lineup](https://qwen.example.org/lineup)',
    '- [Gemma 4 model overview](https://gemma.example.net/overview)',
    '- [LFM2.5-1.2B-Thinking](https://liquid.example.com/lfm2)',
    '- [A site with no mark at all](https://plain.example.dev/page)',
  ].join('\n');
  const base = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [
    { ...base, seq: 1, type: 'session.started', brand: 'codex', externalId: 'fixture', model: 'gpt-5', cwd: projectPath, permissionMode: 'on-request' },
    { ...base, seq: 2, type: 'message.started', messageId: 'answer', role: 'assistant' },
    { ...base, seq: 3, type: 'text.delta', messageId: 'answer', text },
    { ...base, seq: 4, type: 'message.completed', messageId: 'answer' },
    { ...base, seq: 5, type: 'session.state', state: 'idle', label: 'Ready' },
  ];
  const snapshot = foldAll(events);

  // Three sites answer with a mark; the fourth has none, so one picture holds
  // both what a site with a mark draws and what a site without one draws.
  await page.route((url) => url.pathname.endsWith('/favicon.ico') && url.search === CARRIED, (route) => {
    const mark = MARKS[new URL(route.request().url()).hostname];
    if (!mark) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'no mark here' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: mark });
  });

  await page.addInitScript(({ chat, view, carried }) => {
    const carry = (value: string): string => (value.endsWith('/favicon.ico') ? `${value}${carried}` : value);
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name: string, value: string) {
      const favicon = this instanceof HTMLImageElement && name === 'src';
      return setAttribute.call(this, name, favicon ? carry(String(value)) : value);
    };
    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...src,
      set(value: string) { src.set!.call(this, carry(String(value))); },
    });
    class FixtureSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FixtureSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        if (new URL(url).searchParams.get('chat') === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', {
          data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }),
        })), 0);
      }
      close() { this.readyState = FixtureSocket.CLOSED; }
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: FixtureSocket, configurable: true });
  }, { chat: CHAT, view: snapshot, carried: CARRIED });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'fixture', brand: 'codex', title: 'Site badge marks', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: projectPath, runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'fixture', runningElsewhere: false, held: null, title: 'Site badge marks', cwd: projectPath, beads: [] } }));

  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Site badge mark fixture', path: projectPath, isTest: true } });
    expect(made.status(), await made.text()).toBe(201);
    project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Site badge marks' }).getByTestId('row-name').click();
    await expect(page.getByText('Sources:')).toBeVisible();
    const badges = page.locator('[data-testid="markdown-web-badge"][data-web-kind="site"]');
    await expect(badges).toHaveCount(4);

    // One icon per badge, whichever way its mark went: the three sites that
    // have one draw it INSTEAD of the globe, and the one that has none keeps
    // the globe and draws no broken picture beside it.
    for (const index of [0, 1, 2]) {
      await expect(badges.nth(index).getByTestId('external-favicon')).toBeVisible();
      await expect(badges.nth(index).locator('svg')).toHaveCount(0);
    }
    await expect(badges.nth(3).locator('svg')).toHaveCount(1);
    await expect(badges.nth(3).getByTestId('external-favicon')).toHaveCount(0);

    await page.locator('[data-testid="markdown-web-badge"]').first().locator('xpath=ancestor::ul[1]')
      .screenshot({ path: process.env.SITE_BADGE_SHOT || 'tests/results/site-badge-after.png' });

    // And it is drawn where the globe was: the same box, the same distance
    // inside its own pill, to the pixel.
    const mark = (await badges.nth(0).getByTestId('external-favicon').boundingBox())!;
    const globe = (await badges.nth(3).locator('svg').boundingBox())!;
    const markPill = (await badges.nth(0).boundingBox())!;
    const globePill = (await badges.nth(3).boundingBox())!;
    expect(Math.round(mark.width)).toBe(Math.round(globe.width));
    expect(Math.round(mark.height)).toBe(Math.round(globe.height));
    expect(Math.round(mark.x - markPill.x)).toBe(Math.round(globe.x - globePill.x));
    expect(Math.round(mark.y - markPill.y)).toBe(Math.round(globe.y - globePill.y));
  } finally {
    if (project) await request.delete(`/api/projects/${project.id}`);
    discardFixture(run);
  }
});
