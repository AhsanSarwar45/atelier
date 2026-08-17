/**
 * What a chat shows while the agent is actually working.
 *
 * Starts a chat on the isolated instance, sends one prompt that makes the agent
 * think and run a tool, and samples the screen every second: the state badge,
 * how many messages and tool rows are drawn, and what — if anything — stands at
 * the foot of the transcript where the reader is looking.
 */
import { chromium } from 'playwright';

const UI = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3017';
const API = process.env.BEADS_E2E_BACKEND ?? 'http://127.0.0.1:3018';
const SHOT = process.env.SHOT ?? 'tests/results/chat-while-working-before.png';
const SECONDS = Number(process.env.SECONDS ?? 25);

const projects = await (await fetch(`${API}/api/projects`)).json();
const p = projects[0];

const started = await (
  await fetch(`${API}/api/workbench/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'session.start', projectId: p.id, projectPath: p.path, brand: 'claude' }),
  })
).json();
console.log('chat', started.id, 'in', p.path);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
await page.goto(`${UI}/project?id=${p.id}&tab=chat&chat=${started.id}`);
await page.getByTestId('chat-tab').waitFor({ timeout: 60_000 });

await page.getByTestId('composer').fill('Think about which files in this repo are the largest, then run `ls -S` on the repo root and tell me the top three.');
await page.getByTestId('composer').press('Enter');

let shot = false;
for (let i = 0; i < SECONDS; i++) {
  const seen = await page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
    const last = [...document.querySelectorAll('[data-testid="transcript"] > *')].slice(-1)[0];
    return {
      state: document.querySelector('[data-testid="session-state"]')?.getAttribute('data-state') ?? null,
      label: text('[data-testid="session-state"]'),
      messages: document.querySelectorAll('[data-testid="assistant-message"],[data-testid="user-message"]').length,
      tools: document.querySelectorAll('[data-testid="tool-row"]').length,
      thinking: document.querySelectorAll('[data-testid="thinking-block"]').length,
      working: text('[data-testid="working-line"]'),
      foot: (last?.getAttribute('data-testid') ?? last?.tagName ?? '—') + ' :: ' + (last?.textContent ?? '').slice(0, 60),
    };
  });
  console.log(
    String(i).padStart(2),
    's state=', seen.state,
    '| messages=', seen.messages,
    '| tools=', seen.tools,
    '| thinking=', seen.thinking,
    '| working line=', seen.working,
    '| foot=', seen.foot,
  );
  if (!shot && (seen.state === 'thinking' || seen.state === 'running_tool' || seen.state === 'streaming')) {
    await page.screenshot({ path: SHOT });
    shot = true;
    console.log('   (picture taken at this moment ->', SHOT, ')');
  }
  await new Promise((r) => setTimeout(r, 1000));
}

await browser.close();
