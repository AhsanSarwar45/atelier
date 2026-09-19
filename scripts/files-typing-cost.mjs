/**
 * What a keystroke costs in the Files tab's editor.
 *
 * Opens a file, turns editing on, and types — timing each key from the press to
 * the frame that followed it, against files of several sizes.
 *
 *   BEADS_E2E_URL=http://127.0.0.1:3411 node scripts/files-typing-cost.mjs <projectId> <absolute file> ...
 */
import { chromium } from '@playwright/test';

const APP = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3411';
const SLOWER = Number(process.env.CPU_SLOWER ?? 1);
const [projectId, ...paths] = process.argv.slice(2);
if (!projectId || !paths.length) throw new Error('usage: <projectId> <absolute file> ...');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
if (SLOWER > 1) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOWER });
  console.log(`main thread slowed ${SLOWER}x`);
}
await page.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); })
    .observe({ entryTypes: ['longtask'] });
});
const drain = () => page.evaluate(() => { const l = window.__long; window.__long = []; return l; });

for (const path of paths) {
  await page.goto(`${APP}/project?id=${projectId}&tab=files&file=${encodeURIComponent(path)}`,
    { waitUntil: 'commit' });
  await page.locator('.cm-content').waitFor({ timeout: 60_000 });
  const size = await page.evaluate(() => document.querySelector('.cm-content')?.textContent?.length ?? 0);
  const edit = page.locator('[data-testid="file-viewer-edit"]');
  if (await edit.count()) await edit.click();
  await page.waitForTimeout(400);
  await page.locator('.cm-content').click();
  await page.waitForTimeout(300);

  await drain();
  const keys = [];
  for (let i = 0; i < 20; i += 1) {
    const at = Date.now();
    await page.keyboard.type('x');
    await page.evaluate(() => new Promise((go) => requestAnimationFrame(() => requestAnimationFrame(go))));
    keys.push(Date.now() - at);
  }
  const long = await drain();
  keys.sort((a, b) => a - b);
  console.log(
    `${path.split('/').pop().padEnd(22)} ${(size / 1024).toFixed(0).padStart(5)}KB in the editor: ` +
    `key p50 ${keys[10]}ms  p95 ${keys[18]}ms  worst ${keys[19]}ms   ` +
    `blocked ${long.reduce((a, b) => a + b, 0).toFixed(0)}ms in ${long.length} long tasks over 20 keys`,
  );
}
await browser.close();
