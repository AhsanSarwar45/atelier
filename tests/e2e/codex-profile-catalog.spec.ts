import { copyFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { test as base, expect, chromium } from '@playwright/test';
const test = base.extend({ browser: [async ({}, use) => {
  const browser = await chromium.connectOverCDP(process.env.CDP_URL!);
  await use(browser);
}, { scope: 'worker' }] });
// Opt-in live regression: run via workbench-e2e.sh with CODEX_CATALOG_TEST_AUTH,
// optional CODEX_CATALOG_TEST_NAMED_AUTH, and CDP_URL from atelier tool chrome env.
test.skip(!process.env.CODEX_CATALOG_TEST_AUTH || !process.env.CDP_URL, 'Requires an explicit disposable live-provider run and Atelier Chrome');
test('System catalog excludes a retired configured default', async ({ page, request }) => {
  test.setTimeout(180000);
  const run = process.env.WORKBENCH_E2E_RUN!;
  expect(run).toBeTruthy();
  expect(process.env.CODEX_HOME).toBe(join(run, 'codex'));
  expect(process.env.ATELIER_DATA_DIR).toBe(join(run, 'data'));
  expect(new URL(process.env.BEADS_E2E_URL!).port).not.toBe('3008');
  const folder = join(run, 'project');
  mkdirSync(folder, { recursive: true });
  copyFileSync(process.env.CODEX_CATALOG_TEST_AUTH!, join(process.env.CODEX_HOME!, 'auth.json'));
  writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), 'model = "gpt-5.6-sol"\n');
  const response = await request.post('/api/projects', {data:{name:'Profile catalog test',path:folder,isTest:true}});
  expect(response.status()).toBe(201);
  const project = await response.json();
  let namedProfile: string | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route(/\/api\/projects(\?[^/]*)?$/, async route => {
      const url = new URL(route.request().url()); url.searchParams.set('include_test', 'true');
      await route.continue({url:url.toString()});
    });
    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    await page.getByTestId('new-chat-provider-codex').click();
    await page.getByTestId('new-chat-provider-dialog').getByRole('button',{name:'Start chat'}).click();
    await page.waitForURL(url => Boolean(url.searchParams.get('chat')));
    const picker = page.getByTestId('model-picker');
    await expect(picker).not.toHaveText('Model', {timeout:60000});
    await picker.click();
    await page.getByTestId('model-picker-option').first().waitFor();
    await page.screenshot({path:process.env.CATALOG_SHOT || '/tmp/bw-ohg2y-before.png'});
    console.log('CATALOG', await page.getByTestId('model-picker-option').evaluateAll(rows => rows.map(r => r.getAttribute('data-value'))));
    await expect(page.getByTestId('model-picker-option').filter({hasText:'Sol'})).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByTestId('composer').fill('Reply with exactly CATALOG_OK. Do not use tools.');
    await page.getByTestId('send-button').click();
    await expect(page.getByTestId('assistant-message').last()).toContainText('CATALOG_OK', {timeout:120000});
    await expect(picker).not.toHaveAttribute('data-current', 'gpt-5.6-sol');
    await page.reload();
    await picker.click();
    await expect(page.getByTestId('model-picker-option').filter({hasText:'Sol'})).toHaveCount(0);
    await page.screenshot({path:'/tmp/bw-ohg2y-after-reload.png'});
    await page.keyboard.press('Escape');
    if (process.env.CODEX_CATALOG_TEST_NAMED_AUTH) {
      const made = await request.post('/api/workbench/command', {data:{type:'profile.create',brand:'codex',name:'Named account'}});
      expect(made.ok()).toBeTruthy();
      const { profile } = await made.json();
      namedProfile = profile.id;
      const home = join(process.env.ATELIER_DATA_DIR!, 'profiles', 'codex', profile.id);
      copyFileSync(process.env.CODEX_CATALOG_TEST_NAMED_AUTH, join(home, 'auth.json'));
      writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.6-sol"\n');
      await page.getByTestId('new-chat-tool').click();
      await page.getByTestId('new-chat-provider-codex').click();
      await page.getByTestId(`new-chat-profile-${profile.id}`).click();
      await page.getByTestId('new-chat-provider-dialog').getByRole('button',{name:'Start chat'}).click();
      await expect(page.getByTestId('account-picker')).toHaveAttribute('data-current', profile.id);
      await expect(picker).toHaveAttribute('data-current', 'gpt-5.6-sol', {timeout:60000});
      await picker.click();
      await expect(page.getByTestId('model-picker-option').filter({hasText:'Sol'})).toHaveCount(1);
      console.log('NAMED CATALOG', await page.getByTestId('model-picker-option').evaluateAll(rows => rows.map(r => r.getAttribute('data-value'))));
      await page.keyboard.press('Escape');
      await page.getByTestId('composer').fill('Reply with exactly NAMED_OK. Do not use tools.');
      await page.getByTestId('send-button').click();
      await expect(page.getByTestId('assistant-message').last()).toContainText('NAMED_OK', {timeout:120000});

    }
    if (await page.getByTestId('chat-right-rail').getAttribute('data-open') === 'true') {
      await page.getByTestId('chat-right-rail-toggle').click();
    }
    await page.setViewportSize({width:390,height:844});
    await page.getByTestId('mobile-composer-settings').click();
    const mobile = page.getByTestId('mobile-composer-settings-dialog');
    await expect(mobile).toBeVisible();
    await mobile.getByTestId('mobile-model-picker').click();
    await expect(page.getByTestId('mobile-model-picker-option').first()).toBeVisible();
    await page.screenshot({path:'/tmp/bw-ohg2y-mobile.png'});
    expect(errors).toEqual([]);
  } finally {
    if (namedProfile) {
      await request.post('/api/workbench/command', {data:{type:'profile.delete',brand:'codex',profileId:namedProfile}});
      rmSync(join(process.env.ATELIER_DATA_DIR!, 'profiles', 'codex', namedProfile),{recursive:true,force:true});
    }
    await request.delete(`/api/projects/${project.id}`);
    rmSync(folder,{recursive:true,force:true});
  }
});
