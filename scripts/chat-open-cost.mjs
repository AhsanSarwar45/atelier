/**
 * Where the wait goes when a chat is opened.
 *
 * Prints, for one chat: how long the conversation took to arrive, how many rows
 * it holds, how many pieces of screen they cost, and how long the main thread
 * was busy after the bytes landed. Run against a BUILT instance.
 *
 *   BEADS_E2E_URL=http://127.0.0.1:3032 node scripts/chat-open-cost.mjs <sessionId>
 */
import { chromium } from '@playwright/test';

const APP = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3032';
const session = process.argv[2];
if (!session) throw new Error('name the chat: node scripts/chat-open-cost.mjs <sessionId>');

const browser = await chromium.launch();
const page = await browser.newPage();

let snapshotAt = 0;
const started = Date.now();
page.on('response', (r) => {
  if (r.url().includes('/api/workbench/events') && !snapshotAt) snapshotAt = Date.now() - started;
});

const projects = await (await page.request.get(`${APP}/api/projects`)).json();
const project = projects[0];
await page.goto(`${APP}/project?id=${project.id}&tab=chat&chat=${session}`);

const said = page.locator('[data-testid="assistant-message"],[data-testid="user-message"]');
await said.first().waitFor({ timeout: 60_000 });
const firstRow = Date.now() - started;

let rows = -1;
let steady = 0;
while (Date.now() - started < 60_000) {
  const now = await page.locator('[data-testid="transcript"] > *').count();
  if (now === rows && now > 0) {
    if (!steady) steady = Date.now();
    else if (Date.now() - steady >= 250) break;
  } else {
    rows = now;
    steady = 0;
  }
  await page.waitForTimeout(50);
}
const settled = steady - started;
const pieces = await page.evaluate(() => document.querySelectorAll('[data-testid="transcript"] *').length);
const messages = await said.count();

console.log(
  `snapshot arrived ${snapshotAt}ms | first message ${firstRow}ms | still ${settled}ms | ` +
    `${rows} rows (${messages} messages) | ${pieces} pieces of screen`,
);
await browser.close();
