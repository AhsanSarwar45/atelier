/**
 * Only the manager's column offers the button that finishes a job, on the
 * running screen rather than in a rendered component.
 *
 * The unit cases beside epic-card.tsx hold the condition; this holds what a
 * reader actually sees once the screen is built, embedded in the server and
 * served — the three places the last one of these went wrong.
 *
 * The board's own test harness expects @playwright/test, which is not
 * installed; the playwright library is, so this drives the browser itself.
 *
 * Prerequisite: beads-server on localhost:3008, serving a project whose board
 * has at least one job standing in Manager Review.
 *
 *   node tests/signoff-column.mjs
 */
import { chromium } from 'playwright';

const HOST = process.env.BEADS_WEB ?? 'http://127.0.0.1:3008';
const SIGNOFF = /mark done/i;
const MANAGER = 'manager_review';

const fail = (why) => { console.error(`FAIL  ${why}`); process.exitCode = 1; };

const projects = await (await fetch(`${HOST}/api/projects`)).json();
const owner = projects.find(p => p.name.toLowerCase() === (process.env.BOARD ?? 'corsetta'))
  ?? projects[0];
if (!owner) {
  console.error('no project on this machine has a board — nothing to check');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
await page.goto(`${HOST}/project?id=${owner.id}`);
await page.locator('[data-column]').first().waitFor({ state: 'visible', timeout: 30_000 });
await page.locator(`[data-column="${MANAGER}"]`).waitFor({ state: 'visible', timeout: 30_000 });

let waiting = 0;
for (const column of await page.locator('[data-column]').all()) {
  const status = await column.getAttribute('data-column');
  const title = (await column.locator('h2').first().textContent() ?? '').trim();
  const cards = await column.locator('[data-bead-id]').count();
  const buttons = await column.getByRole('button', { name: SIGNOFF }).count();
  console.log(`${title.padEnd(16)} cards=${String(cards).padStart(3)}  sign-off buttons=${buttons}`);

  if (status === MANAGER) waiting = cards;
  else if (buttons > 0) fail(`${title} offers ${buttons} sign-off button(s), and only the manager's column may`);
}

if (waiting === 0) {
  console.error('no job is standing in the manager\'s column, so there is nothing to check');
  process.exit(2);
}

const finished = page.locator(`[data-column="${MANAGER}"] [data-bead-id]`)
  .filter({ hasText: '100%' });
const ready = await finished.count();
const offered = await finished.getByRole('button', { name: SIGNOFF }).count();
if (offered !== ready) {
  fail(`${ready} job(s) in the manager's column have every piece closed but ${offered} offer him a sign-off`);
}

await browser.close();
if (!process.exitCode) {
  console.log(`only the manager's column offers a sign-off (${offered} of ${offered} finished jobs there carry one)`);
}
