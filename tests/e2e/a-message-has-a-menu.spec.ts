/**
 * A right-click on a message, or a long press on a phone, opens a menu of what
 * can be done with it, and "Copy message" puts its words on the clipboard
 * (bw-yszdw). In the open chat the menu also resends his own message, puts it
 * back in the box to edit, quotes a message in reply and copies a link that
 * opens the chat at it; and Select all in the box on an Android phone stays in
 * the box (bw-drvtr).
 *
 *   BEADS_E2E_ACP_ADAPTERS="$PWD/tests/fixtures/acp-adapters" \
 *     scripts/workbench-e2e.sh tests/e2e/a-message-has-a-menu.spec.ts
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

type Project = { id: string; path: string };

const ROOT = join(__dirname, '..', '.workbench-run-message-menu');
const SHOTS = 'tests/results/a-message-has-a-menu';
const LINE = 'Hello, say you read this.';

test.skip(
  !process.env.BEADS_E2E_ACP_ADAPTERS?.includes('tests/fixtures/acp-adapters'),
  'needs the scripted ACP agent; see the comment above',
);

let project: Project | undefined;
let sessionId = '';

test.beforeAll(async ({ request }) => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const made = await request.post('/api/projects', {
    data: { name: 'message menu fixture', path: ROOT, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  project = (await made.json()) as Project;
  const started = await request.post('/api/workbench/command', {
    data: {
      type: 'session.start',
      projectId: project.id,
      projectPath: project.path,
      brand: 'claude',
      permissionMode: 'bypassPermissions',
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  sessionId = ((await started.json()) as { id: string }).id;
});

test.afterAll(async ({ request }) => {
  if (project) await request.delete(`/api/projects/${project.id}`, { timeout: 10_000 }).catch(() => undefined);
  rmSync(ROOT, { recursive: true, force: true });
});

async function openChat(page: Page) {
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  await page.goto(`/project?id=${project!.id}&tab=chat&chat=${sessionId}`);
  await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });
}

test.describe.serial('the message menu', () => {
  test('a right-click copies the message', async ({ page, context }) => {
    test.setTimeout(180_000);
    mkdirSync(SHOTS, { recursive: true });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openChat(page);
    await page.getByTestId('composer').fill(LINE);
    await page.getByTestId('send-button').click();
    const reply = page.getByTestId('assistant-message').filter({ hasText: `read: ${LINE}` });
    await expect(reply).toHaveCount(1, { timeout: 60_000 });

    await reply.click({ button: 'right', position: { x: 40, y: 12 } });
    const menu = page.getByTestId('message-menu');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('message-menu-copy-selection')).toHaveCount(0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/right-click.png` });
    await page.getByTestId('message-menu-copy').click();
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`read: ${LINE}`);

    // Selected words are offered on their own.
    await reply.locator('p').first().selectText();
    await reply.click({ button: 'right', position: { x: 40, y: 12 } });
    await expect(page.getByTestId('message-menu-copy-selection')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/right-click-with-selection.png` });
    await page.getByTestId('message-menu-copy-selection').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`read: ${LINE}`);
  });

  test('a long press on a phone opens the same menu', async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    await openChat(page);
    const reply = page.getByTestId('assistant-message').filter({ hasText: `read: ${LINE}` });
    await expect(reply).toHaveCount(1, { timeout: 60_000 });
    await page.evaluate(() => navigator.clipboard.writeText(''));

    const box = (await reply.boundingBox())!;
    const at = { x: box.x + 30, y: box.y + box.height / 2 };
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
    await page.waitForTimeout(800);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByTestId('message-menu')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/long-press.png` });
    await page.getByTestId('message-menu-copy').tap();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`read: ${LINE}`);
    await context.close();
  });
  test('resend, edit, quote and link', async ({ page, context }) => {
    test.setTimeout(180_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openChat(page);
    const mine = page.getByTestId('user-message').filter({ hasText: LINE });
    const replies = page.getByTestId('assistant-message').filter({ hasText: `read: ${LINE}` });
    await expect(mine).toHaveCount(1, { timeout: 60_000 });
    const composer = page.getByTestId('composer');

    // Edit and resend: the words go back in the box, nothing is sent yet.
    await mine.click({ button: 'right', position: { x: 30, y: 12 } });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/own-message-menu.png` });
    await page.getByTestId('message-menu-edit').click();
    await expect(composer).toHaveValue(LINE);
    await expect(mine).toHaveCount(1);

    // Quote in reply: added after what is there, as a quote.
    await replies.first().click({ button: 'right', position: { x: 30, y: 12 } });
    await page.getByTestId('message-menu-quote').click();
    await expect(composer).toHaveValue(new RegExp(`^${LINE.replace(/[.,]/g, '\\$&')}\\n\\n> Agent \\d+ read: ${LINE.replace(/[.,]/g, '\\$&')}\\n\\n$`));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/quoted.png` });

    // Resend: the same words go out again as a new message, and the box keeps
    // what is in it.
    const before = await composer.inputValue();
    await mine.first().click({ button: 'right', position: { x: 30, y: 12 } });
    await page.getByTestId('message-menu-resend').click();
    await expect(mine).toHaveCount(2, { timeout: 30_000 });
    await expect(replies).toHaveCount(2, { timeout: 60_000 });
    await expect(composer).toHaveValue(before);
    await page.screenshot({ path: `${SHOTS}/resent.png` });

    // Copy link to message: opening it lands on that message, marked.
    await replies.first().click({ button: 'right', position: { x: 30, y: 12 } });
    await page.getByTestId('message-menu-copy-link').click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/\/project\?id=.+&tab=chat&chat=.+&message=.+/);
    await page.goto('/');
    await page.goto(link);
    const marked = page.locator('[data-found]');
    await expect(marked).toHaveCount(1, { timeout: 30_000 });
    await expect(marked.getByTestId('assistant-message')).toContainText(`read: ${LINE}`);
    await page.screenshot({ path: `${SHOTS}/opened-from-link.png` });
  });

  test('Select all in the box on an Android phone stays in the box', async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await openChat(page);
    await expect(page.getByTestId('assistant-message').first()).toBeVisible({ timeout: 60_000 });
    const box = page.locator('.cm-content').first();
    await box.click();
    await page.keyboard.insertText('only these words');
    // The phone's Select all runs the browser's own select-all command.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    const seen = await page.evaluate(() => ({
      selected: getSelection()?.toString() ?? '',
      // The plain editing host is what keeps a select-all inside the box.
      editContext: Boolean((document.querySelector('.cm-content') as HTMLElement & { editContext?: unknown }).editContext),
      supported: 'EditContext' in window,
    }));
    expect(seen.supported).toBe(true);
    expect(seen.editContext).toBe(false);
    expect(seen.selected).toBe('only these words');
    await context.close();
  });
});
