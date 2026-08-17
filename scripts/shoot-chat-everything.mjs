/**
 * The picture this job is judged on: a command opened onto its own output, and
 * the line carrying the answer `/compact` gave.
 *
 * Runs one small turn in a fresh chat, opens everything, and saves the foot of
 * the transcript. Wants an instance with its own data, never the owner's board.
 *
 *   BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3018 \
 *     node scripts/shoot-chat-everything.mjs tests/results/chat-shows-everything.png
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { chromium } from 'playwright';

const screen = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3017';
const api = process.env.BEADS_E2E_BACKEND ?? 'http://127.0.0.1:3018';
const out = process.argv[2] ?? 'tests/results/chat-shows-everything.png';

const projects = await (await fetch(`${api}/api/projects`)).json();
const project = projects[0];

const started = await (
  await fetch(`${api}/api/workbench/command`, {
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.goto(`${screen}/project?id=${project.id}&tab=chat&chat=${started.id}`);
await page.getByTestId('mode-picker').waitFor({ timeout: 120_000 });

// Let it run without stopping to ask, so the picture has a command in it.
await page.getByTestId('mode-picker').click();
await page.locator('[data-testid="mode-picker-option"][data-value="bypassPermissions"]').click();
await page.waitForTimeout(1500);

async function say(text) {
  await page.getByTestId('composer').fill(text);
  await page.getByTestId('composer').press('Escape');
  await page.getByTestId('composer').press('Enter');
  await page.waitForTimeout(1000);
}

await say('Run exactly this in the shell and say nothing else: echo the-output-is-on-the-row');
const row = page.getByTestId('tool-row').first();
await row.waitFor({ timeout: 180_000 });
await page.waitForTimeout(6000);

mkdirSync(dirname(out), { recursive: true });

// The command, opened onto what it ran and what it printed.
await row.getByTestId('tool-toggle').click();
await row.scrollIntoViewIfNeeded();
await page.waitForTimeout(800);
await page.screenshot({ path: out });
console.log(`saved ${out}`);

// And what the chat says about compaction, whichever way it goes.
await say('/compact');
const answer = page.getByTestId('note-row').filter({ hasText: /compact/i }).first();
await answer.waitFor({ timeout: 180_000 });
await page.waitForTimeout(2000);
await page.getByTestId('transcript').evaluate((el) => el.scrollTo(0, el.scrollHeight));
await page.waitForTimeout(800);
const second = out.replace(/\.png$/, '-compact.png');
await page.screenshot({ path: second });
console.log(`saved ${second}`);
await browser.close();
process.exit(0);
