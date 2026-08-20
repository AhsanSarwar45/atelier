/**
 * What one keystroke costs, and whether it costs more the longer you have talked.
 *
 * Typing into the composer redraws the chat around the transcript — the same
 * redraw an arriving word causes. Every row is remembered against its own
 * message, so that redraw should cost one box and nothing else. It cost the
 * whole conversation instead: what the chat knows about disk was built fresh on
 * every pass, the list of what may be clicked is built from it, and that list
 * is handed to every message — a new one on every pass is a new prop on all of
 * them, and the remembering is defeated on the way in. Two thousand messages
 * had their markdown parsed again per character, at two and a half seconds a
 * keystroke (bw-2lzj.1).
 *
 * That is why this runs at more than one length: a number on its own cannot
 * tell a fast page from a short one.
 *
 *   node scripts/chat-typing-cost.mjs [url] [messages...]
 *
 * Prints what it measured as JSON and fails when a keystroke costs more than
 * MOST, or when the longest conversation costs more than SPREAD times the
 * shortest — either the conversation is being rebuilt for each character again,
 * or the page has gone back to being measured whole.
 */
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3008';
const SIZES = process.argv.length > 3 ? process.argv.slice(3).map(Number) : [200, 2000];

/** What a keystroke may cost, in milliseconds, before this is a fault again. */
const MOST = 16;
/**
 * How much dearer the longest conversation's keystroke may be than the shortest's.
 * Flat is the point: what it costs to type must not be what it costs to have
 * talked.
 */
const SPREAD = 2;

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
  // The whole conversation on the first ask, and nothing on any later one. A
  // fulfilled answer is a CLOSED stream, so the page opens it again a moment
  // later; answering that with the conversation a second time folds it onto
  // itself and measures a chat nine times longer than the one asked for.
  await page.route('**/api/workbench/events**', (route) => {
    const since = Number(new URL(route.request().url()).searchParams.get('since') ?? 0);
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: since > 0 ? ': nothing new\n\n' : body,
    });
  });
  await page.goto(`${base}/project?id=${encodeURIComponent(project.id)}&tab=chat&chat=probe`, {
    waitUntil: 'domcontentloaded',
  });
  // The newest message, not a count of them: a chat draws the screenful the
  // reader is looking at and reaches back for older ones as he scrolls up
  // (bw-2lzj.2), so waiting for every message ever said would wait forever.
  await page.waitForFunction(
    (want) => {
      const said = document.querySelectorAll('[data-testid$="-message"]');
      const last = said[said.length - 1];
      return Boolean(last?.textContent?.includes(`Message ${want}`));
    },
    held - 1,
    { timeout: 180000 },
  );

  await page.locator('[data-testid="composer-frame"] textarea').first().click();
  const each = [];
  for (const ch of 'the quick brown fox jumps over') {
    const at = Date.now();
    await page.keyboard.type(ch);
    each.push(Date.now() - at);
  }

  // What the growing box's own measurement costs, on its own: flattening the box
  // and reading its height back is a question the browser answers by settling the
  // page first. Kept because it is the other way a keystroke can go slow, and
  // reading near zero here is what says the cost is elsewhere.
  const measuring = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="composer"]');
    if (!box) return null;
    const taken = [];
    for (let i = 0; i < 10; i += 1) {
      const t0 = performance.now();
      box.style.height = 'auto';
      void box.scrollHeight;
      box.style.height = `${box.scrollHeight}px`;
      taken.push(performance.now() - t0);
    }
    taken.sort((a, b) => a - b);
    return Math.round(taken[Math.floor(taken.length / 2)] * 100) / 100;
  });

  const drawn = await page.evaluate(
    () => document.querySelectorAll('[data-testid="transcript"] > *').length,
  );
  await page.close();

  each.sort((a, b) => a - b);
  runs.push({
    messages: held,
    rowsOnThePage: drawn,
    perKeyMedian: each[Math.floor(each.length / 2)],
    perKeyWorst: each[each.length - 1],
    measuringTheBox: measuring,
    keystrokes: each.length,
  });
}

await browser.close();
console.log(JSON.stringify({ base, runs }, null, 2));

const worst = runs.reduce((a, b) => (b.perKeyMedian > a.perKeyMedian ? b : a));
if (worst.perKeyMedian > MOST) {
  console.error(
    `a keystroke costs ${worst.perKeyMedian}ms on ${worst.messages} messages; ${MOST}ms is the most it may cost`,
  );
  process.exit(1);
}
const first = runs[0];
const last = runs[runs.length - 1];
if (runs.length > 1 && last.perKeyMedian > Math.max(first.perKeyMedian, 1) * SPREAD) {
  console.error(
    `a keystroke costs ${last.perKeyMedian}ms on ${last.messages} messages against ${first.perKeyMedian}ms on ${first.messages}; ` +
      'what it costs to type must not be what it costs to have talked',
  );
  process.exit(1);
}
