/**
 * The two pictures this job is judged on: the chat's top line saying how much of
 * the five-hour plan window is gone, when it comes back, and how much of the
 * week has gone beside it — and the panel either chip opens.
 *
 * Costs nothing to run: the figure comes from the kit's own usage channel, not
 * from a turn, so no message is ever sent in the chat this opens.
 *
 *   BEADS_E2E_URL=http://127.0.0.1:3018 node scripts/shoot-plan-usage.mjs
 *
 * Wants an instance built from THIS worktree with its own settings DB, never
 * the owner's board — `scripts/workbench-e2e.sh` sets exactly that up.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { chromium } from 'playwright';

const screen = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3018';
const api = process.env.BEADS_E2E_BACKEND ?? screen;
const chipOut = process.argv[2] ?? 'tests/results/plan-chip.png';
const panelOut = process.argv[3] ?? 'tests/results/plan-panel.png';

/** What the sidecar itself says, so the log carries the number the picture shows. */
const usage = await (await fetch(`${api}/api/workbench/usage`)).json();
console.log(`usage: ${JSON.stringify(usage.session)} week=${JSON.stringify(usage.week)}`);
if (!usage.available) {
  console.log('SKIP: plan usage unavailable');
  process.exit(1);
}

/** A project of our own, marked as a test one so it stays off the owner's dashboard. */
const here = process.cwd();
const existing = await (await fetch(`${api}/api/projects?include_test=true`)).json();
const project =
  existing.find((p) => p.path === here) ??
  (await (
    await fetch(`${api}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'plan-usage-shot', path: here, isTest: true }),
    })
  ).json());

const started = await (
  await fetch(`${api}/api/workbench/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'session.start', projectId: project.id, projectPath: project.path, brand: 'claude' }),
  })
).json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
// The fixture project is marked as a test one so it stays off any dashboard,
// and that same filtering hides it from its OWN tab: the page resolves a
// project out of the plain list. So this page asks for test projects too,
// exactly as the end-to-end spec does.
await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
  if (route.request().method() !== 'GET') return await route.continue();
  const url = new URL(route.request().url());
  url.searchParams.set('include_test', 'true');
  await route.continue({ url: url.toString() });
});
await page.goto(`${screen}/project?id=${project.id}&tab=chat&chat=${started.id}`);

const chip = page.getByTestId('plan-chip');
await chip.waitFor({ timeout: 60_000 });
const week = page.getByTestId('plan-chip-week');
await week.waitFor({ timeout: 60_000 });
const said = (await chip.textContent())?.trim() ?? '';
const saidWeek = (await week.textContent())?.trim() ?? '';
console.log(`the line says: ${said} | ${saidWeek}`);
// Both figures, drawn: the week was once in a hover tooltip only, which is a
// figure the reader does not have and a screenshot cannot show (bw-malh.5).
if (!/\d+%/.test(said) || !/\d+%/.test(saidWeek)) {
  console.log('the line is missing one of the two percentages');
  process.exit(1);
}

// The line, not the whole window: what is being claimed is one strip of pixels
// at the top of the chat, and a full-page shot of an empty transcript hides it.
mkdirSync(dirname(chipOut), { recursive: true });
mkdirSync(dirname(panelOut), { recursive: true });
await page.locator('[data-testid="chat-tab"] > div').first().screenshot({ path: chipOut });

// Opened from the keyboard, not the mouse: this chip is the only way into the
// usage picture in the app, so a reader who does not use a mouse has no other
// way in (bw-malh.7). Focus has to land ON it, and Enter has to open it.
await chip.focus();
const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '');
if (focused !== 'plan-chip') {
  console.log(`the chip does not take focus: focus sat on ${focused || 'nothing'}`);
  process.exit(1);
}
await page.keyboard.press('Enter');
const panel = page.getByTestId('usage-view');
await panel.waitFor({ timeout: 30_000 });
await page.waitForTimeout(400);
const windows = await page.getByTestId('usage-window').count();
console.log(`the panel draws ${windows} window(s)`);
await panel.screenshot({ path: panelOut });

await browser.close();
// The chat this opened is closed again: a run that leaves chats behind puts
// them on the owner's list (bw-6m6w).
await fetch(`${api}/api/workbench/command`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'session.stop', sessionId: started.id }),
});
console.log(`wrote ${chipOut} and ${panelOut}`);
