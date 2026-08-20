/**
 * What a board waits for between the click and its first card.
 *
 * Prints every request the app makes from the moment a project is clicked
 * until a card is drawn, in the order they were asked, with what each cost.
 * Anything in that list nobody asked for is a wait the reader pays for on
 * every board open (bw-uiyz.14).
 *
 * Run it against a BUILT instance, never `next dev`: a development build
 * compiles each screen as it is asked for and its numbers are its own.
 *
 *   node scripts/board-open-cost.mjs http://127.0.0.1:3032
 */
import { chromium } from '@playwright/test';

const APP = process.argv[2] ?? 'http://127.0.0.1:3032';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${APP}/`, { waitUntil: 'commit' });

const rows = page.locator('[aria-label^="View "]');
await rows.first().waitFor({ timeout: 120_000 });
// Let the project list finish everything it starts, so what follows is the
// board's own cost and not the list's tail.
await page.waitForTimeout(1_000);

const log = [];
let t0 = 0;
page.on('request', (r) => log.push({ at: Date.now() - t0, url: r.url(), r }));
page.on('requestfinished', (r) => {
  const asked = log.find((x) => x.r === r);
  if (asked) asked.done = Date.now() - t0;
});

const cards = page.locator('[aria-label^="Select bead"], [aria-label^="Select epic"]');
t0 = Date.now();
await rows.first().click();
await cards.first().waitFor({ timeout: 120_000 });
const drawn = Date.now() - t0;
// Catch anything the board asks for after it is already on the screen.
await page.waitForTimeout(1_500);

console.log(`first card ${drawn}ms after the click; ${log.length} requests:`);
for (const asked of log.sort((a, b) => a.at - b.at)) {
  const url = new URL(asked.url);
  const where = url.pathname + (url.search ? `?${url.search.slice(1, 60)}` : '');
  const took = (asked.done ?? -1) - asked.at;
  console.log(`  ${String(asked.at).padStart(5)}ms +${String(took).padStart(5)}ms  ${where}`);
}

await browser.close();
