/**
 * A working chat says what it is doing, and shows the thinking.
 *
 * The rule this holds is the manager's, 2026-08-17: "when the agent is
 * processing/thinking/running command, i see nothing." No unit test can see it
 * — what must be true is that the screen CHANGES while an agent works — so this
 * opens a chat, sends one real prompt, and samples the screen every second: the
 * state, how many messages, tool rows and thinking blocks are drawn, and what
 * stands at the foot of the transcript.
 *
 * It fails when any second of a busy turn has nothing at the foot, or when a
 * turn that thought drew no thinking at all.
 *
 * Wants a screen serving this checkout and an instance with its own data — never
 * the one serving the owner's board:
 *
 *   PORT=3017 NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3018 npx next dev -p 3017
 *   BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3018 \
 *     node scripts/chat-shows-its-work.mjs
 *
 * It starts a chat and spends one small turn. SHOT= writes a picture of the
 * first working second; ASK= replaces the prompt.
 */
import { chromium } from 'playwright';

const UI = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3017';
const API = process.env.BEADS_E2E_BACKEND ?? 'http://127.0.0.1:3018';
const SHOT = process.env.SHOT ?? '';
const SECONDS = Number(process.env.SECONDS ?? 30);
const ASK =
  process.env.ASK ??
  'Think about which files in this repo are the largest, then run `ls -S` on the repo root and tell me the top three.';

const projects = await (await fetch(`${API}/api/projects`)).json();
const project = projects[0];

const started = await (
  await fetch(`${API}/api/workbench/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'session.start',
      projectId: project.id,
      projectPath: project.path,
      brand: 'claude',
    }),
  })
).json();
console.log('chat', started.id, 'in', project.path);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
await page.goto(`${UI}/project?id=${project.id}&tab=chat&chat=${started.id}`);
await page.getByTestId('chat-tab').waitFor({ timeout: 120_000 });

await page.getByTestId('composer').fill(ASK);
await page.getByTestId('composer').press('Enter');

/** Seconds the agent was working, and what the screen showed in each of them. */
const busySeconds = [];
let thinkingEver = 0;
let thoughtEver = false;
let shot = !SHOT;

for (let i = 0; i < SECONDS; i++) {
  const seen = await page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
    return {
      state: document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') ?? null,
      messages: document.querySelectorAll('[data-testid="assistant-message"],[data-testid="user-message"]').length,
      tools: document.querySelectorAll('[data-testid="tool-row"]').length,
      thinking: document.querySelectorAll('[data-testid="thinking-block"]').length,
      working: text('[data-testid="working-line"]'),
      thought: (text('[data-testid="working-line"]') ?? '').includes('thought'),
    };
  });
  const busy = ['thinking', 'streaming', 'running_tool', 'waiting_permission'].includes(seen.state ?? '');
  if (busy) busySeconds.push(seen);
  thinkingEver = Math.max(thinkingEver, seen.thinking);
  thoughtEver = thoughtEver || seen.thought;
  console.log(
    String(i).padStart(2),
    's state=', seen.state,
    '| messages=', seen.messages,
    '| tools=', seen.tools,
    '| thinking=', seen.thinking,
    '| at the foot:', seen.working ?? '—',
  );

  // Answer a permission card the way he would, so the turn actually runs.
  const ask = page.getByTestId('permission-allow_once');
  if (await ask.first().isVisible().catch(() => false)) await ask.first().click();

  // The picture is of a chat at work: the first second the foot has something to
  // say and the agent is not merely waiting on him.
  if (!shot && seen.working && seen.state !== 'waiting_permission') {
    await page.screenshot({ path: SHOT });
    shot = true;
    console.log('   (picture of a working chat ->', SHOT, ')');
  }
  await new Promise((r) => setTimeout(r, 1000));
}

await browser.close();

const silent = busySeconds.filter((s) => !s.working);
console.log(
  `\n${busySeconds.length} seconds of work, ${silent.length} of them with nothing at the foot; ` +
    `thinking blocks: ${thinkingEver}; thinking size shown: ${thoughtEver}`,
);

if (!busySeconds.length) {
  console.error('FAIL: agent did not start');
  process.exit(1);
}
if (silent.length) {
  console.error(`FAIL: ${silent.length} working seconds showed nothing at the foot of the transcript.`);
  process.exit(1);
}
// Either the thinking itself, or — when the brand withholds it — how much of it
// there has been. One of the two must be on the screen, but only for a turn that
// actually thought for a while: plenty of turns answer without thinking at all,
// and demanding a sign of one then would fail an honest screen.
const thoughtSeconds = busySeconds.filter((s) => s.state === 'thinking').length;
if (thoughtSeconds > 2 && !thinkingEver && !thoughtEver) {
  console.error(
    `FAIL: ${thoughtSeconds} seconds of thinking and the screen said nothing about it, neither the words nor the size.`,
  );
  process.exit(1);
}
console.log('PASS: activity and thinking remained visible');
