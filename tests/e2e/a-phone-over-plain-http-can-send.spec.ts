/**
 * A phone that opens the app over plain HTTP can send a message (bw-fe8vm).
 *
 * The manager opens the app from a phone on the same network, by its address,
 * over plain HTTP. Such a page is not a secure context, so the browser gives
 * it no `crypto.randomUUID`. The send button named the new message with it,
 * the call threw, and pressing Send on Firefox mobile did nothing at all.
 *
 * Run against an address that is not localhost, so the page is insecure:
 *
 *   BEADS_WEB_HOST=<this machine's LAN address> \
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" \
 *     scripts/workbench-e2e.sh tests/e2e/a-phone-over-plain-http-can-send.spec.ts
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-phone-plain-http');
const SHOTS = 'tests/results/a-phone-over-plain-http-can-send';
const LINE = 'Hello from the phone, say you read this.';

test.skip(
  !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'),
  'needs the scripted ACP agent; see the comment above',
);

test.use({ browserName: 'firefox', viewport: { width: 390, height: 844 }, hasTouch: true });

let project: Project | undefined;

test.beforeAll(async ({ request }) => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'phone plain http fixture', path: ROOT, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  project = (await made.json()) as Project;
});

test.afterAll(async ({ request }) => {
  if (project) await request.delete(`/api/projects/${project.id}`, { timeout: 10_000 }).catch(() => undefined);
  rmSync(ROOT, { recursive: true, force: true });
});

test('tapping Send on a plain-HTTP page sends the message', async ({ page, request }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const started = await request.post('/api/workbench/command', {
    data: {
      type: 'session.start',
      projectId: project!.id,
      projectPath: project!.path,
      brand: 'claude',
      permissionMode: 'bypassPermissions',
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const sessionId = ((await started.json()) as { id: string }).id;

  await page.goto(`/project?id=${project!.id}&tab=chat&chat=${sessionId}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
  const insecure = await page.evaluate(() => ({
    secure: window.isSecureContext,
    randomUUID: typeof (crypto as Partial<Crypto>).randomUUID,
    firefox: navigator.userAgent.includes('Firefox'),
  }));
  expect(insecure, 'the page must be one Firefox on a phone on the network gets')
    .toEqual({ secure: false, randomUUID: 'undefined', firefox: true });

  await page.getByTestId('composer').fill(LINE);
  await page.getByTestId('send-button').tap();

  await expect(page.getByTestId('user-message').filter({ hasText: LINE })).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId('assistant-message').filter({ hasText: `read: ${LINE}` }))
    .toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('composer')).toHaveValue('');
  expect(errors).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/sent-from-a-phone.png` });
});
