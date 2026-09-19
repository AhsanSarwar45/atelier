/**
 * Where the wait goes when a file is opened in the Files tab.
 *
 * One page, opened once, then driven the way a person drives it: a click in the
 * tree, and the clock stopped when the text is on screen. Each file is opened,
 * then opened again, so what the app kept is visible in the second number. Run
 * against a BUILT instance.
 *
 *   BEADS_E2E_URL=http://127.0.0.1:3411 node scripts/files-open-cost.mjs <projectId> <root> <relative path> ...
 */
import { chromium } from '@playwright/test';

const APP = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3411';
const [projectId, root, ...wanted] = process.argv.slice(2);
if (!projectId || !root || !wanted.length) {
  throw new Error('usage: node scripts/files-open-cost.mjs <projectId> <root> <relative path> ...');
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const SLOWER = Number(process.env.CPU_SLOWER ?? 1);
if (SLOWER > 1) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOWER });
  console.log(`main thread slowed ${SLOWER}x\n`);
}

await page.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__long.push([e.startTime, e.duration]);
  }).observe({ entryTypes: ['longtask'] });
});

/** Every call the page makes, so a click's true cost in journeys is countable. */
const calls = [];
page.on('response', (r) => {
  const url = r.url();
  if (!url.includes('/api/')) return;
  calls.push({ at: Date.now(), url: url.replace(APP, '') });
});
const since = (at) => calls.filter((c) => c.at >= at);
const drainLong = () => page.evaluate(() => { const l = window.__long; window.__long = []; return l; });
const blockedIn = (long) => long.reduce((s, [, d]) => s + d, 0);
const tally = (made) => {
  const kinds = {};
  for (const c of made) {
    const kind = c.url.split('?')[0].replace('/api/', '');
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}x${n}`).join(' ');
};

function report(label, ms, long, made) {
  console.log(
    `  ${label.padEnd(26)} ${ms.toFixed(0).padStart(6)}ms   ` +
    `blocked ${blockedIn(long).toFixed(0).padStart(5)}ms/${String(long.length).padStart(2)} tasks ` +
    `(worst ${long.reduce((m, [, d]) => Math.max(m, d), 0).toFixed(0)}ms)   ${made.length} calls: ${tally(made)}`,
  );
}

const rowFor = (name) => page.locator('[data-testid="files-tree-row"]', { hasText: name });
const viewerText = () => page.evaluate(
  () => document.querySelector('[data-testid="files-viewer"]')?.textContent?.length ?? 0,
);

/** Shut every folder, so the row wanted next is drawn where it can be clicked. */
async function collapseAll() {
  for (let guard = 0; guard < 40; guard += 1) {
    const open = page.locator('[data-testid="files-tree-row"][aria-expanded="true"]');
    if (!(await open.count())) return;
    await open.first().click();
    await page.waitForTimeout(120);
  }
}

async function expandTo(rel) {
  await collapseAll();
  await page.locator('[data-testid="files-tree-scroller"]').evaluate((e) => { e.scrollTop = 0; });
  for (const part of rel.split('/').slice(0, -1)) {
    const row = rowFor(part).first();
    await row.waitFor({ timeout: 30_000 });
    if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
    await page.waitForTimeout(200);
  }
}

/** Click the file's row and stop the clock when its text is drawn. */
async function clickOpen(rel, label) {
  const name = rel.split('/').pop();
  await drainLong();
  const before = await viewerText();
  const from = Date.now();
  await rowFor(name).first().click();
  await page.waitForFunction(
    ([n, was]) => {
      const named = decodeURIComponent(new URL(location.href).searchParams.get('file') ?? '').endsWith(n);
      const body = document.querySelector('[data-testid="files-viewer"]')?.textContent?.length ?? 0;
      return named && body > 0 && body !== was;
    },
    [name, before], { timeout: 120_000 },
  );
  const ms = Date.now() - from;
  report(label, ms, await drainLong(), since(from));
  return ms;
}

/** Click some other file that is on screen right now, so the re-open is real. */
async function elsewhere(rel) {
  const name = rel.split('/').pop();
  const rows = page.locator('[data-testid="files-tree-row"][aria-expanded]');
  const all = page.locator('[data-testid="files-tree-row"]');
  const count = await all.count();
  for (let i = 0; i < count; i += 1) {
    const row = all.nth(i);
    if (await row.getAttribute('aria-expanded') !== null) continue;
    const text = (await row.textContent()) ?? '';
    if (text.includes(name)) continue;
    await row.click();
    return;
  }
  void rows;
  throw new Error('no other file on screen to step away to');
}

const treeFrom = Date.now();
await page.goto(`${APP}/project?id=${projectId}&tab=files`, { waitUntil: 'commit' });
await page.locator('[data-testid="files-tree-row"]').first().waitFor({ timeout: 120_000 });
const firstRow = Date.now() - treeFrom;
await page.waitForTimeout(1500);
console.log(`tree: first row ${firstRow}ms after the address was entered, ` +
  `${await page.locator('[data-testid="files-tree-row"]').count()} rows drawn, ` +
  `${since(treeFrom).length} calls made`);

for (const rel of wanted) {
  const size = await page.evaluate(async ([app, p]) => {
    const r = await fetch(`${app}/api/fs/read?path=${encodeURIComponent(p)}`);
    return ((await r.json()).text ?? '').length;
  }, [APP, `${root}/${rel}`]);
  console.log(`\n${rel}  (${(size / 1024).toFixed(0)}KB)`);
  await expandTo(rel);
  await clickOpen(rel, 'first open');
  await elsewhere(rel);
  await page.waitForTimeout(900);
  await clickOpen(rel, 're-open');
}

console.log('\nleaving the tab and coming back');
await page.locator('[data-testid="tab-chat"]').click();
await page.waitForTimeout(1500);
await drainLong();
const backFrom = Date.now();
await page.locator('[data-testid="tab-files"]').click();
await page.locator('[data-testid="files-tree-row"]').first().waitFor({ timeout: 60_000 });
report('back to Files', Date.now() - backFrom, await drainLong(), since(backFrom));

console.log('\nten seconds of an open, untouched Files tab');
await drainLong();
const idleFrom = Date.now();
await page.waitForTimeout(10_000);
const idle = since(idleFrom);
console.log(`  ${idle.length} calls in 10s: ${tally(idle)}`);
console.log(`  main thread blocked ${blockedIn(await drainLong()).toFixed(0)}ms while idle`);

await browser.close();
