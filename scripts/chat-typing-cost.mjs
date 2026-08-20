/**
 * What one keystroke costs on a long conversation.
 *
 * Typing into the composer redraws the chat around the transcript — the same
 * redraw an arriving word causes, and the same one the busy clock used to cause
 * once a second. On two hundred messages that redraw was the whole conversation:
 * every message's markdown parsed again, every diff coloured again, a quarter of
 * a second per character (bw-uiyz.5). Each row is remembered against its own item
 * now, so the price of a keystroke is one row.
 *
 * The conversation is fed to the app's own event stream rather than taken from
 * whatever chats this machine happens to hold, so the number means the same thing
 * everywhere.
 *
 *   node scripts/chat-typing-cost.mjs [url] [messages]
 *
 * Prints what it measured as JSON and fails when a keystroke costs more than
 * MOST — a whole conversation being rebuilt cannot come back unnoticed.
 */
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3008';
const HELD = Number(process.argv[3] ?? 200);

/** What a keystroke may cost, in milliseconds, before this is a fault again. */
const MOST = 40;

const body = [];
let seq = 0;
const line = (e) => body.push(`data: ${JSON.stringify({ ...e, seq: (seq += 1), sessionId: 'probe', at: '' })}\n\n`);
for (let i = 0; i < HELD; i += 1) {
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

const projects = await (await fetch(`${base}/api/projects`)).json();
const project = projects.find((p) => !p.archivedAt && !p.isTest) ?? projects[0];
if (!project) throw new Error('no project on this server to open a chat in');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.route('**/api/workbench/events**', (route) =>
  route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: body.join('') }),
);

await page.goto(`${base}/project?id=${encodeURIComponent(project.id)}&tab=chat&chat=probe`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(
  (want) => document.querySelectorAll('[data-testid$="-message"]').length >= want,
  HELD,
  { timeout: 180000 },
);

await page.locator('[data-testid="composer-frame"] textarea').first().click();
const each = [];
for (const ch of 'the quick brown fox jumps over') {
  const at = Date.now();
  await page.keyboard.type(ch);
  each.push(Date.now() - at);
}
await browser.close();

each.sort((a, b) => a - b);
const median = each[Math.floor(each.length / 2)];
console.log(
  JSON.stringify(
    {
      base,
      messages: HELD,
      perKeyMedian: median,
      perKeyWorst: each[each.length - 1],
      typingTotal: each.reduce((a, b) => a + b, 0),
      keystrokes: each.length,
    },
    null,
    2,
  ),
);

if (median > MOST) {
  console.error(`a keystroke costs ${median}ms on ${HELD} messages; ${MOST}ms is the most it may cost`);
  process.exit(1);
}
