/**
 * How long a chat takes to become readable, and whether talking longer costs.
 *
 * A chat drew every message it had ever held. Two thousand of them is forty
 * thousand pieces of screen and 2.9 seconds before the first word is readable —
 * paid on every open, for a reader who is looking at the last screenful of it.
 * The conversation now draws the newest screenful and reaches back for older
 * ones as he scrolls up (bw-2lzj.2).
 *
 *   node scripts/chat-opens-fast.mjs [url] [messages...]
 *
 * Prints what it measured as JSON and fails when a chat takes longer than MOST
 * to draw, when the longest conversation takes more than SPREAD times the
 * shortest, or when the page holds more than PIECES pieces of screen — which is
 * what says the whole conversation is in the page again.
 */
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3008';
const SIZES = process.argv.length > 3 ? process.argv.slice(3).map(Number) : [200, 2000];

/** How long a chat may take to be readable, in milliseconds. */
const MOST = 700;
/**
 * How much dearer the longest conversation's open may be than the shortest's.
 * Flat is the point: what it costs to open a chat must not be what it costs to
 * have talked.
 */
const SPREAD = 2;
/** How many pieces of screen a drawn conversation may hold at rest. */
const PIECES = 2_000;

function transcript(held) {
  const body = [];
  let seq = 0;
  const line = (e) => body.push(`data: ${JSON.stringify({ ...e, seq: (seq += 1), sessionId: 'probe', at: '' })}\n\n`);
  for (let i = 0; i < held; i += 1) {
    const messageId = `m${i}`;
    line({ type: 'message.started', messageId, role: i % 2 ? 'assistant' : 'user' });
    line({
      type: 'text.delta',
      messageId,
      text: `## Message ${i}\n\nSomething the agent said about \`file-${i}.ts\`, with a list:\n\n- one\n- two\n- three\n\n\`\`\`ts\nexport function thing${i}(a: number): number {\n  return a * ${i};\n}\n\`\`\`\n`,
    });
    line({ type: 'message.completed', messageId });
  }
  line({ type: 'session.state', state: 'idle', label: 'Idle' });
  return body.join('');
}

const projects = await (await fetch(`${base}/api/projects`)).json();
const project = projects.find((p) => !p.archivedAt && !p.isTest) ?? projects[0];
if (!project) throw new Error('no project on this server to open a chat in');

const browser = await chromium.launch();
const runs = [];

for (const held of SIZES) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const body = transcript(held);
  // The whole conversation on the first ask, and nothing on any later one: a
  // fulfilled answer is a CLOSED stream, so the page opens it again a moment
  // later, and answering that with the conversation a second time folds it onto
  // itself.
  await page.route('**/api/workbench/events**', (route) => {
    const since = Number(new URL(route.request().url()).searchParams.get('since') ?? 0);
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: since > 0 ? ': nothing new\n\n' : body,
    });
  });

  // The app itself first, so what is measured is opening a chat rather than
  // downloading the whole screen.
  await page.goto(`${base}/project?id=${encodeURIComponent(project.id)}&tab=chat`, { waitUntil: 'networkidle' });

  const at = Date.now();
  await page.goto(`${base}/project?id=${encodeURIComponent(project.id)}&tab=chat&chat=probe`, {
    waitUntil: 'domcontentloaded',
  });
  // The newest message readable, which is what opening a chat means. Not a
  // count of them: the older ones are reached by scrolling up.
  await page.waitForFunction(
    (want) => {
      const said = document.querySelectorAll('[data-testid$="-message"]');
      const last = said[said.length - 1];
      return Boolean(last?.textContent?.includes(`Message ${want}`));
    },
    held - 1,
    { timeout: 180000 },
  );
  const drawnMs = Date.now() - at;

  const held_on = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-testid="transcript"] > *').length,
    pieces: document.querySelectorAll('[data-testid="transcript"] *').length,
  }));
  await page.close();

  runs.push({ messages: held, drawnMs, rowsOnThePage: held_on.rows, piecesOfScreen: held_on.pieces });
}

await browser.close();
console.log(JSON.stringify({ base, runs }, null, 2));

let wrong = false;
for (const run of runs) {
  if (run.drawnMs > MOST) {
    console.error(`a chat of ${run.messages} messages took ${run.drawnMs}ms to draw; ${MOST}ms is the most it may take`);
    wrong = true;
  }
  if (run.piecesOfScreen > PIECES) {
    console.error(
      `a chat of ${run.messages} messages holds ${run.piecesOfScreen} pieces of screen; ${PIECES} is the most it may hold`,
    );
    wrong = true;
  }
}
const first = runs[0];
const last = runs[runs.length - 1];
if (runs.length > 1 && last.drawnMs > Math.max(first.drawnMs, 1) * SPREAD) {
  console.error(
    `a chat of ${last.messages} messages took ${last.drawnMs}ms against ${first.drawnMs}ms for ${first.messages}; ` +
      'what it costs to open a chat must not be what it costs to have talked',
  );
  wrong = true;
}
if (wrong) process.exit(1);
