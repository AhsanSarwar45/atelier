/**
 * Eight windows of the app open at once, and every read still answered at once.
 *
 * The fault this holds shut: a browser allows six connections to one address
 * across every window it has, and an event stream never gives its slot back.
 * The app used to open one stream per feed, so two windows spent the whole
 * budget and every ordinary read queued behind streams that would never end —
 * a screen stuck on loading until it was reloaded. Fanning the feeds into one
 * stream moved the wall from two windows to five; it did not remove it,
 * because one stream per window is still one of the six (bw-zkh4, bw-zkh4.10).
 *
 * What removes it is the connection no longer being an event stream. A browser
 * does not ration sockets against those six, so this opens more windows than
 * the budget has room for and checks that they are all connected at once and
 * that nothing is queueing behind them — which is only possible if the app's
 * live connections cost the reads nothing at all.
 *
 * The board's own harness expects @playwright/test, which is not installed;
 * the playwright library is, so this drives the browser itself.
 *
 * Prerequisite: atelier serving a project with a board.
 *
 *   node tests/many-windows.mjs
 */
import { execSync } from 'node:child_process';

import { chromium } from 'playwright';

const HOST = process.env.ATELIER_URL ?? 'http://127.0.0.1:3008';
const PORT = new URL(HOST).port || '80';
/** More than the six a browser allows one address, which is the whole point. */
const WINDOWS = Number(process.env.WINDOWS ?? 8);
/** What counts as answered at once, from inside a window that is already up. */
const AT_ONCE_MS = 1_000;

const fail = (why) => {
  console.error(`FAIL  ${why}`);
  process.exitCode = 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The browser's own established sockets to the app, counted from outside it.
 *
 * Chrome's only, because the reader's own browser is very likely on the same
 * app and its connections are not this measurement's.
 */
function heldByTheBrowser() {
  const out = execSync(`ss -tn state established '( dport = :${PORT} )' -p`).toString();
  return out
    .trim()
    .split('\n')
    .slice(1)
    .filter((line) => /chrome/.test(line))
    .map((line) => line.replace(/\s+/g, ' ').trim());
}

const projects = await (await fetch(`${HOST}/api/projects`)).json();
const owner = projects.find((p) => p.path && !p.path.startsWith('dolt://')) ?? projects[0];
if (!owner) {
  console.error('no project on this machine has a board — nothing to check');
  process.exit(2);
}

const browser = await chromium.launch();
// One context, many pages: what a browser rations is its own, counted across
// every window of one profile, so separate contexts would be separate budgets
// and would prove nothing.
const context = await browser.newContext();

// Counts what the page itself opens, rather than guessing from outside which
// socket is which.
await context.addInitScript(() => {
  const Real = window.WebSocket;
  window.__wires = [];
  window.WebSocket = class extends Real {
    constructor(...asked) {
      super(...asked);
      window.__wires.push(this);
    }
  };
});

const pages = [];
for (let i = 0; i < WINDOWS; i++) {
  const page = await context.newPage();
  await page.goto(`${HOST}/project?id=${owner.id}&tab=board`, { waitUntil: 'load' });
  pages.push(page);
}

// The connections open after the first paint; give every window time to settle
// into what it watches rather than catching it mid-reshape.
await sleep(8_000);

const live = [];
for (const page of pages) {
  live.push(
    await page.evaluate(() =>
      (window.__wires ?? []).filter((w) => w.readyState === WebSocket.OPEN).map((w) => w.url),
    ),
  );
}
const open = live.flat();
const held = heldByTheBrowser();

console.log(`windows open:            ${pages.length}`);
console.log(`live connections held:   ${open.length}`);
console.log(`sockets to :${PORT}:        ${held.length}`);

if (open.length !== WINDOWS) {
  fail(`${WINDOWS} windows should hold ${WINDOWS} live connections, and they hold ${open.length}`);
}
if (live.some((w) => w.length !== 1)) {
  fail(`a window held more than one live connection: ${JSON.stringify(live)}`);
}
if (open.some((url) => !/^wss?:/.test(url) || !url.includes('/api/live'))) {
  fail(`a live connection is not the app's one wire: ${open.join(', ')}`);
}
// Eight connections standing at once to one address is itself the proof that
// they are not on the budget of six: under it, the last two could not exist.
if (held.length < WINDOWS) {
  fail(`the browser holds ${held.length} sockets to the app for ${WINDOWS} windows, so some window never connected`);
}

// The symptom, measured where the reader met it: an ordinary read, from a
// window that has been up for a while, with every other window still open.
const reads = [];
for (const [i, page] of pages.entries()) {
  const took = await page.evaluate(async () => {
    const began = performance.now();
    await fetch('/api/projects', { cache: 'no-store' });
    return Math.round(performance.now() - began);
  });
  reads.push(took);
  if (took > AT_ONCE_MS) fail(`the read from window ${i + 1} took ${took} ms`);
}
console.log(`reads, window by window: ${reads.map((ms) => `${ms} ms`).join(', ')}`);

await browser.close();

if (!process.exitCode) {
  console.log(
    `\n${WINDOWS} windows open, ${open.length} live connections held, ` +
      `0 of them on the browser's HTTP budget of six, ` +
      `and every read answered in under ${AT_ONCE_MS} ms (slowest ${Math.max(...reads)} ms)`,
  );
}
