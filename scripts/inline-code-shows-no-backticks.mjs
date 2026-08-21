/**
 * Every inline code chip, read for the backtick it must not be wearing.
 *
 * The typography preset draws a backtick of its own before and after any
 * quoted word — the same mark the markdown already spent making the chip — so
 * a command in a message read `like this`, quote marks and all, everywhere the
 * app draws prose: a chat message and a card's Notes or Design field alike,
 * because both go through the one renderer (src/components/markdown-body.tsx).
 * The fix adds `prose-code:before:content-none prose-code:after:content-none`
 * to that renderer's own class list (card bw-3ndt.1). A fenced block was never
 * touched — the preset already resets `pre code::before`/`::after` on its own —
 * so this checks that one too, as the control that says the fix reaches only
 * what it was meant to.
 *
 * Self-contained: it starts its own `next dev` (a HIGH port, never 3007-3009 —
 * those belong to a running instance) and answers every `/api/*` call itself
 * with `page.route`, the same trick `chat-opens-fast.mjs` uses to fabricate a
 * transcript — so no backend, no Rust binary and no other session's board is
 * ever touched. It fails when any inline chip's `::before` or `::after`
 * computed `content` is anything other than `none` / `""` / `normal`.
 *
 *   node scripts/inline-code-shows-no-backticks.mjs [port]
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 3117);
const BASE = `http://127.0.0.1:${PORT}`;
const SCREENSHOT = path.join(ROOT, 'tests/results/inline-code-no-backticks.png');

const PROJECT_ID = 'inline-code-probe';
// A dolt:// path so the fabricated project never asks for a file watcher or a
// worktree status — there is no real directory behind it to watch.
const PROJECT_PATH = 'dolt://inline-code-probe';
const CARD_ID = 'inline-code-probe-card';
const SESSION_ID = 'probe';

const project = {
  id: PROJECT_ID,
  name: 'Inline code probe',
  path: PROJECT_PATH,
  tags: [],
  lastOpened: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

/** A card whose Notes carry an inline command AND a fenced block, and whose
 * Design carries a second, differently-shaped inline chip — so the check
 * covers more than one quoted word in more than one field. */
const bead = {
  id: CARD_ID,
  title: 'A card with inline code',
  status: 'open',
  priority: 2,
  issue_type: 'task',
  comments: [],
  notes: `Run \`bd show ${CARD_ID}\` to see it.\n\n\`\`\`\nfenced block, unaffected\n\`\`\`\n`,
  design: 'See `design-doc.md` for what this changes.',
};

/** The chat half: one assistant message with two inline chips and a fenced
 * block, fabricated as an SSE body the way chat-opens-fast.mjs does it — a
 * fulfilled answer is a CLOSED stream, so the page reopens it a moment later,
 * and answering that with nothing new is what keeps the transcript from
 * folding onto itself. */
function transcriptBody() {
  const lines = [];
  let seq = 0;
  const line = (e) => lines.push(`data: ${JSON.stringify({ ...e, seq: (seq += 1), sessionId: SESSION_ID, at: '' })}\n\n`);
  line({ type: 'message.started', messageId: 'm1', role: 'assistant' });
  line({
    type: 'text.delta',
    messageId: 'm1',
    text: 'Run `bd show ' + CARD_ID + '` or `git status` to see where it stands.\n\n```bash\necho hi\n```\n',
  });
  line({ type: 'message.completed', messageId: 'm1' });
  line({ type: 'session.state', state: 'idle', label: 'Idle' });
  return lines.join('');
}

/** Answers every request this screen makes without a real backend anywhere —
 * a project, its one card, an empty chat sidebar, and the transcript above.
 * Anything asked for that none of this cares about gets a harmless `{}`. */
async function mockBackend(page) {
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (p === '/api/projects') return json([project]);
    if (p === '/api/reports') return json([]);
    if (p === '/api/fs/roots') return json({ home: '/home/probe', roots: [] });
    if (p === '/api/version/check') return json({ current: '0.0.0', latest: '0.0.0', updateAvailable: false });
    if (p === '/api/beads') return json({ beads: [bead], source: 'dolt' });
    if (p.startsWith('/api/workbench/links/bead/')) return json([]);
    if (p.startsWith('/api/workbench/restore')) return json([]);
    if (p.startsWith('/api/projects/') && p.endsWith('/touch')) return json({});
    if (p.startsWith('/api/workbench/watch')) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: ': nothing\n\n' });
    }
    if (p.startsWith('/api/workbench/events')) {
      const since = Number(url.searchParams.get('since') ?? 0);
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: since > 0 ? ': nothing new\n\n' : transcriptBody(),
      });
    }
    return json({});
  });
}

/** Starts `next dev` on PORT, detached so the whole process group it spawns
 * (webpack's own worker included) can be killed as one at the end. */
function startDevServer() {
  // Same-origin `/api/*`, unset on purpose: with NEXT_PUBLIC_BACKEND_URL empty
  // the app calls its own origin, which is exactly what page.route intercepts.
  const env = { ...process.env };
  delete env.NEXT_PUBLIC_BACKEND_URL;
  const child = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  return child;
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE);
      if (res.ok || res.status === 404) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`next dev never answered on ${BASE} within ${timeoutMs}ms`);
}

function stopDevServer(child) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

async function main() {
  const server = startDevServer();
  let browser;
  try {
    await waitForServer(60_000);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await mockBackend(page);

    // The chat half and the card half, opened together: the address puts both
    // the open chat and the open card on the one screen at once
    // (card-panel.tsx — the panel slides over whichever tab is showing).
    await page.goto(`${BASE}/project?id=${PROJECT_ID}&tab=chat&chat=${SESSION_ID}&card=${CARD_ID}`, {
      waitUntil: 'domcontentloaded',
    });

    await page.waitForFunction(
      () => {
        const said = document.querySelectorAll('[data-testid$="-message"]');
        return Array.from(said).some((el) => el.textContent?.includes('git status'));
      },
      { timeout: 30_000 },
    );

    await page.getByTestId('bead-detail').waitFor({ timeout: 30_000 });
    // Notes and Design are collapsed <details> — closed content is not what a
    // reader sees, so open both before reading anything out of them.
    await page.locator('[data-testid="bead-detail"] summary', { hasText: 'Design' }).click();
    await page.locator('[data-testid="bead-detail"] summary', { hasText: 'Notes' }).click();
    await page.waitForTimeout(200);

    await mkdir(path.dirname(SCREENSHOT), { recursive: true });
    await page.screenshot({ path: SCREENSHOT, fullPage: true });

    const result = await page.evaluate(() => {
      const wears = (content) => content !== 'none' && content !== '""' && content !== 'normal';
      const chipsOf = (root) =>
        Array.from(root.querySelectorAll('.prose code')).filter((el) => !el.closest('pre'));
      const describe = (el) => ({
        text: (el.textContent ?? '').slice(0, 60),
        before: getComputedStyle(el, '::before').content,
        after: getComputedStyle(el, '::after').content,
      });

      const chatChips = document.querySelectorAll('[data-testid$="-message"]');
      const chat = Array.from(chatChips).flatMap((el) => chipsOf(el)).map(describe);
      const cardRoot = document.querySelector('[data-testid="bead-detail"]');
      const card = cardRoot ? chipsOf(cardRoot).map(describe) : [];

      const fenced = Array.from(document.querySelectorAll('.prose pre code')).map(describe);

      return { chat, card, fenced };
    });

    await browser.close();
    browser = null;

    const inline = [...result.chat, ...result.card];
    const wears = (c) => !['none', '""', 'normal'].includes(c.before) || !['none', '""', 'normal'].includes(c.after);
    const badInline = inline.filter(wears);
    const badFenced = result.fenced.filter(wears);

    const summary = {
      inspected: inline.length,
      chatChips: result.chat.length,
      cardChips: result.card.length,
      offenders: badInline.length,
      fencedBlocksSeen: result.fenced.length,
      fencedOffenders: badFenced.length,
      screenshot: SCREENSHOT,
    };
    console.log(JSON.stringify(summary, null, 2));

    let failed = false;
    if (inline.length === 0) {
      console.error('FAIL: no inline code chip was found to inspect — the fabricated message and card drew nothing');
      failed = true;
    }
    if (result.fenced.length === 0) {
      console.error('FAIL: no fenced code block was found — the sanity control has nothing to compare against');
      failed = true;
    }
    if (badFenced.length > 0) {
      console.error(`FAIL: ${badFenced.length} fenced code block(s) wear a backtick too — that was never meant to move`);
      failed = true;
    }
    if (badInline.length > 0) {
      console.error(`FAIL: ${badInline.length} of ${inline.length} inline code chips wear a backtick:`);
      for (const c of badInline) console.error(`  "${c.text}" before=${c.before} after=${c.after}`);
      failed = true;
    }
    if (failed) process.exitCode = 1;
    else console.log(`PASS: 0 of ${inline.length} inline code chips wear a backtick.`);
  } catch (err) {
    console.error('FAIL:', err instanceof Error ? err.stack ?? err.message : err);
    if (server.output) console.error('--- next dev output ---\n' + server.output);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopDevServer(server);
  }
}

await main();
