/**
 * A card's report button opens that card's report, in a real browser.
 *
 * The page is built by running the report tools inside the project, so the
 * request has to carry the project's directory on disk. Sent without one — or
 * sent a Dolt board's own address, which is not a directory — the server
 * answers 422 and the reader gets a build failure where the page should be.
 *
 * The board's own test harness expects @playwright/test, which is not
 * installed; the playwright library is, so this drives the browser itself.
 *
 * Prerequisite: beads-server on localhost:3008, serving a project that has a
 * report attached to one of its cards.
 *
 *   node tests/card-report.mjs
 */
import { chromium } from 'playwright';

const HOST = process.env.BEADS_WEB ?? 'http://127.0.0.1:3008';

const fail = (why) => { console.error(`FAIL  ${why}`); process.exitCode = 1; };

const reports = await (await fetch(`${HOST}/api/reports`)).json();
const projects = await (await fetch(`${HOST}/api/projects`)).json();
const carded = reports.filter(r => r.card);
const owner = projects.find(p => carded.some(r => r.project === p.name.toLowerCase()));
if (!owner) {
  console.error('no project on this machine has a report attached to a card — nothing to check');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const asked = [];
page.on('response', r => {
  if (r.url().includes('/api/reports/page')) asked.push(r);
});

await page.goto(`${HOST}/project?id=${owner.id}`);
const button = page.getByRole('button', { name: 'Manager report' }).first();
try {
  await button.waitFor({ state: 'visible', timeout: 20_000 });
  await button.click();
  await page.waitForResponse(r => r.url().includes('/api/reports/page'), { timeout: 30_000 });
} catch {
  fail('no card on this board offers a report button that opens anything');
}

for (const r of asked) {
  const path = new URL(r.url()).searchParams.get('path');
  if (!path) fail('the button asked for a report with no directory to build it in');
  else if (r.status() !== 200) {
    const why = (await r.text().catch(() => '')).split('\n').slice(0, 2).join(' ');
    fail(`the button opened ${r.status()} instead of the report — ${why}`);
  }
}

await browser.close();
if (!process.exitCode) console.log(`a card's report button opens its report (${asked.length} asked, all 200)`);
