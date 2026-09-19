/**
 * What happens when one file is opened while the last one is still being read.
 *
 * A reader clicking down a folder, or clicking again while the five-second
 * look at the open file is in the air, asks for a second file before the first
 * has answered. This times exactly that, with the answer deliberately slowed so
 * the overlap is certain rather than lucky.
 *
 *   BEADS_E2E_URL=http://127.0.0.1:3411 SLOW_READ_MS=900 node scripts/files-click-through.mjs <projectId>
 */
import { chromium } from '@playwright/test';

const APP = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3411';
const SLOW = Number(process.env.SLOW_READ_MS ?? 900);
const [projectId, ...names] = process.argv.slice(2);
if (!projectId || names.length < 3) throw new Error('usage: <projectId> <fileA> <fileB> <fileC>');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

// A disk that takes its time. Nothing else about the app is changed.
let reads = 0;
if (SLOW > 0) {
  await page.route('**/api/fs/read**', async (route) => {
    reads += 1;
    await new Promise((go) => setTimeout(go, SLOW));
    await route.continue();
  });
} else {
  page.on('request', (r) => { if (r.url().includes('/api/fs/read')) reads += 1; });
}

await page.goto(`${APP}/project?id=${projectId}&tab=files`, { waitUntil: 'commit' });
await page.locator('[data-testid="files-tree-row"]').first().waitFor({ timeout: 90_000 });
await page.waitForTimeout(1500);

const rows = page.locator('[data-testid="files-tree-row"]');
const [a, b, c] = names;
console.log(`reads answered after ${SLOW}ms; stepping between ${a} and ${b}\n`);

const named = () => page.evaluate(
  () => decodeURIComponent(new URL(location.href).searchParams.get('file') ?? '').split('/').pop() ?? '',
);
const shown = () => page.evaluate(() => {
  const v = document.querySelector('[data-testid="files-viewer"]');
  return (v?.textContent ?? '').length;
});

/** Drawn means: this file is named in the header, and its text is on screen. */
async function waitForText(name) {
  const from = Date.now();
  await page.waitForFunction(
    (n) => {
      const crumb = document.querySelector('[data-testid="file-viewer-breadcrumb"]')?.textContent ?? '';
      if (!crumb.trim().endsWith(n)) return false;
      if (document.querySelector('[data-testid="file-viewer-loading"]')) return false;
      const body = document.querySelector('.cm-content')?.textContent
        ?? document.querySelector('[data-testid="file-viewer-plain"]')?.textContent ?? '';
      return body.length > 0;
    },
    name, { timeout: 60_000 },
  );
  return Date.now() - from;
}

// 1. One at a time, the way a patient reader does it.
await rows.filter({ hasText: a }).first().click();
console.log(`patient: ${a} drawn ${await waitForText(a)}ms after the click`);
await page.waitForTimeout(1500);
await rows.filter({ hasText: b }).first().click();
console.log(`patient: ${b} drawn ${await waitForText(b)}ms after the click`);

// 2. The second click while the first read is still in the air.
await page.waitForTimeout(2000);
for (const gap of (process.env.GAPS ?? '50,200,400,700').split(',').map(Number)) {
  await rows.filter({ hasText: c }).first().click();     // somewhere else first
  await waitForText(c);
  await page.waitForTimeout(1200);
  await rows.filter({ hasText: a }).first().click();     // starts a read of a
  await page.waitForTimeout(gap);                        // …still in the air
  await rows.filter({ hasText: b }).first().click();
  const drew = await waitForText(b);
  console.log(`clicked ${b} ${String(gap).padStart(3)}ms into the read of ${a}: ` +
    `drawn after ${String(drew).padStart(5)}ms  (one read takes ${SLOW}ms)`);
  await page.waitForTimeout(1500);
}

// 3. The five-second look at the open file, and a click that lands during it.
console.log('');
for (let go = 0; go < 3; go += 1) {
  await rows.filter({ hasText: c }).first().click();
  await waitForText(c);
  await rows.filter({ hasText: a }).first().click();
  await waitForText(a);
  // Nobody touches anything; wait for the tab's own re-read of the open file.
  const polled = page.waitForRequest((r) => r.url().includes('/api/fs/read'), { timeout: 15_000 });
  await polled;
  await rows.filter({ hasText: b }).first().click();
  const drew = await waitForText(b);
  console.log(`clicked ${b} as the tab re-read ${a} of its own accord: drawn after ${String(drew).padStart(5)}ms`);
  await page.waitForTimeout(1200);
}

console.log(`\n${reads} reads went to the server in all`);
void shown; void named;
await browser.close();
