/**
 * A chat reads like a piece of work rather than a wall of grey text.
 *
 * Ten things the manager asked for on 2026-08-19 after reading a chat in the
 * app, every one of them a fact about the SCREEN that no unit test can see:
 * whether a change is red and green, whether a command is coloured, whether a
 * card named in a sentence can be clicked, whether the line says how full the
 * conversation is, whether the count at the end of the cards opens the rest,
 * whether a clicked chip stays the size it was, whether a card wears a picture
 * the way a report does, what the button that starts a chat says, whether
 * reading a chat moves it in the list, and whether a chat also being typed into
 * in a terminal goes on growing here.
 *
 * ## How it gets a chat to look at
 *
 * The event log IS the transcript (docs/agent-workbench.md §4): a chat draws
 * exactly what its log holds, replayed from the first row. So nine of the ten
 * are checked against a chat this script writes straight into the log — one
 * command, one file read, one edit, one sentence naming a card and a report,
 * six cards on its line, a fullness figure. Deterministic, and it spends
 * nothing.
 *
 * The tenth cannot be faked, because the whole of it is that the app re-reads
 * the agent kit's own record: it runs a real one-turn chat in a terminal, opens
 * it here, then spends a second turn in the terminal and watches the open chat
 * grow. That costs two very short turns.
 *
 * ## Running it
 *
 * Wants a screen serving this checkout and an instance with its own data —
 * never the one serving the owner's board:
 *
 *   scripts/live-preview.sh                        # or any instance of this build
 *   BEADS_E2E_URL=http://127.0.0.1:3017 \
 *   BEADS_E2E_BACKEND=http://127.0.0.1:3018 \
 *   BEADS_WORKBENCH_DB=$XDG_DATA_HOME/atelier/workbench.db \
 *     node scripts/chat-reads-like-work.mjs
 *
 * SHOTS=<dir> writes a picture of each failure. ONLY=4,5 runs some of them.
 * NO_TERMINAL=1 drops the tenth, for a run with no `claude` on the machine —
 * and says so rather than passing it.
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { chromium } from 'playwright';

const UI = process.env.BEADS_E2E_URL ?? 'http://127.0.0.1:3017';
const API = process.env.BEADS_E2E_BACKEND ?? 'http://127.0.0.1:3018';
const DB = process.env.BEADS_WORKBENCH_DB;
const SHOTS = process.env.SHOTS ?? '';
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);

/**
 * One turn in a terminal, with nothing on its standard input.
 *
 * Left as a pipe, the kit waits three seconds for something to be piped in and
 * then says so — and a run that answers that warning instead of the prompt is a
 * run that proves nothing.
 */
function terminalTurn(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`claude ${args[0]} exited ${code}: ${(err || out).trim().slice(-300)}`)),
    );
  });
}

if (!DB) {
  console.error('FAIL: set BEADS_WORKBENCH_DB to the workbench store of the instance being looked at.');
  console.error('      Never the owner\'s own: this script writes chats into it.');
  process.exit(1);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/* ------------------------------------------------------------------ *
 * What the instance already has: a project, its cards, its reports.
 * ------------------------------------------------------------------ */

const projects = await (await fetch(`${API}/api/projects`)).json();
const project = projects[0];
if (!project) {
  console.error('FAIL: the instance has no projects, so there is no chat to draw.');
  process.exit(1);
}

const board = await (await fetch(`${API}/api/beads?path=${encodeURIComponent(project.path)}`)).json();
const cardIds = (board.beads ?? []).map((b) => b.id).filter((id) => typeof id === 'string');
if (cardIds.length < 7) {
  console.error(`FAIL: ${project.path} has ${cardIds.length} cards; this needs at least 7 to crowd a line.`);
  process.exit(1);
}

const reports = await (await fetch(`${API}/api/reports`)).json().catch(() => []);
/** A report whose card is on this board, so it can ride the chat's line too. */
const report = (Array.isArray(reports) ? reports : []).find((r) => cardIds.includes(r.card)) ?? reports?.[0] ?? null;

/* ------------------------------------------------------------------ *
 * A chat, written into the log the way the app writes one.
 * ------------------------------------------------------------------ */

const db = new DatabaseSync(DB);
const now = new Date();
/** Distinct, older than anything real, so a seeded chat cannot jump the list. */
const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

function seedSession({ title, minutesAgo }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO session (id, brand, external_id, project_id, project_path, cwd, model,
       permission_mode, title, state, origin, created_at, last_active_at, imported_recipe)
     VALUES (?,?,NULL,?,?,?,NULL,?,?,?,?,?,?,999)`,
  ).run(
    id, 'claude', project.id, project.path, project.path,
    'default', title, 'dormant', 'app', at(minutesAgo + 5), at(minutesAgo),
  );
  return id;
}

let seq = 0;
function say(sessionId, e, minutesAgo) {
  seq += 1;
  const full = { ...e, seq, sessionId, at: at(minutesAgo) };
  db.prepare('INSERT INTO event (session_id, seq, at, type, json) VALUES (?,?,?,?,?)')
    .run(sessionId, seq, full.at, full.type, JSON.stringify(full));
}

const READ_FILE = 'src/workbench/context-window.ts';
// The comment runs over three lines, and the middle of it says something that
// reads as code if the line is painted on its own — which is what the colouring
// used to do to every comment and every long string in a chat (bw-4wcd.16).
const COMMENT = ['/**', ' * How full it stands: const used = 1;', ' */'];
const BEFORE = [...COMMENT, 'export function reads(used: number): string {', '  return `${used}`;', '}'].join('\n');
const AFTER = [...COMMENT, 'export function reads(used: number, window: number): string {', '  return `${used}/${window}`;', '}'].join('\n');

/** The chat the nine screen facts are read off. */
function seedTranscript(sessionId, minutesAgo) {
  const said = (role, text) => {
    const messageId = randomUUID();
    say(sessionId, { type: 'message.started', messageId, role }, minutesAgo);
    say(sessionId, { type: 'text.delta', messageId, text }, minutesAgo);
    say(sessionId, { type: 'message.completed', messageId }, minutesAgo);
  };
  const called = ({ name, input, title, output, diff }) => {
    const toolCallId = randomUUID();
    say(sessionId, { type: 'tool.started', toolCallId, name, input, title, parentToolCallId: null }, minutesAgo);
    if (diff) say(sessionId, { type: 'diff', toolCallId, ...diff }, minutesAgo);
    say(sessionId, { type: 'tool.completed', toolCallId, ok: true, output }, minutesAgo);
  };

  say(sessionId, { type: 'session.state', state: 'dormant', label: 'Asleep' }, minutesAgo);
  said('user', 'Make the fullness figure say what it is out of.');

  // A command: shell, coloured as shell, printing what a terminal prints.
  called({
    name: 'Bash',
    input: { command: 'grep -n "export function reads" -A 2 ' + READ_FILE, description: 'Find the function' },
    title: 'grep -n "export function reads"',
    output: `101:export function reads(used: number): string {\n102:  return \`\${used}\`;\n103:}`,
  });

  // A file read: the file's own language, and the kit's line numbers kept.
  called({
    name: 'Read',
    input: { file_path: READ_FILE },
    title: READ_FILE,
    output: BEFORE.split('\n').map((line, i) => `   ${101 + i}\t${line}`).join('\n'),
  });

  // An edit: what it removed and what it put there.
  called({
    name: 'Edit',
    input: { file_path: READ_FILE, old_string: BEFORE, new_string: AFTER },
    title: READ_FILE,
    output: 'Applied 1 edit',
    diff: { path: READ_FILE, before: BEFORE, after: AFTER },
  });

  const named = report ? ` The page is ${report.slug}.` : '';
  said('assistant', `Done — that is ${cardIds[0]} finished.${named}`);

  // Enough cards that the line has to crowd them, so the count at the end has
  // something to open.
  for (const id of cardIds.slice(0, 6)) say(sessionId, { type: 'link.bead', beadId: id, via: 'tool' }, minutesAgo);
  if (report) say(sessionId, { type: 'report.available', project: report.project, slug: report.slug }, minutesAgo);

  say(sessionId, { type: 'context', used: 115_127, window: 200_000 }, minutesAgo);
  say(sessionId, { type: 'cost', cost: { kind: 'usd', usd: 0.42 } }, minutesAgo);
}

// Two chats, so the list has an order that reading one could disturb.
const older = seedSession({ title: 'A chat that must keep its place', minutesAgo: 240 });
seedTranscript(older, 240);
const chat = seedSession({ title: 'A chat that reads like work', minutesAgo: 120 });
seedTranscript(chat, 120);
db.close();

/* ------------------------------------------------------------------ *
 * Looking at it.
 * ------------------------------------------------------------------ */

const results = [];
const wanted = (n) => ONLY.length === 0 || ONLY.includes(String(n));

async function check(n, what, fn) {
  if (!wanted(n)) return;
  try {
    const detail = await fn();
    results.push({ n, what, ok: true, detail: detail ?? '' });
    console.log(`PASS  .${String(n).padEnd(2)} ${what}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ n, what, ok: false, detail: err.message });
    console.log(`FAIL  .${String(n).padEnd(2)} ${what} — ${err.message}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/item-${n}.png` }).catch(() => {});
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
page.setDefaultTimeout(20_000);

/** Back inside the chat with every row open, whatever the last check opened. */
async function openChat() {
  await page.goto(`${UI}/project?id=${project.id}&tab=chat&chat=${chat}`);
  await page.getByTestId('tool-row').first().waitFor();
  for (const toggle of await page.getByTestId('tool-toggle').all()) {
    await toggle.click({ timeout: 5_000 }).catch(() => {});
  }
  await page.waitForTimeout(500);
}

await openChat();

await check(1, 'an edit reads as a diff, red and green, coloured for the language', async () => {
  const diff = page.getByTestId('diff-view').first();
  await diff.waitFor();
  const seen = await diff.evaluate((el) => {
    const bg = (row, side) => getComputedStyle(row.children[side]).backgroundColor;
    const removed = el.querySelector('tr[data-diff-kind="removed"], tr[data-diff-kind="changed"]');
    const added = el.querySelector('tr[data-diff-kind="added"], tr[data-diff-kind="changed"]');
    return {
      language: el.getAttribute('data-diff-language'),
      left: removed ? bg(removed, 0) : null,
      right: added ? bg(added, 1) : null,
      painted: el.querySelectorAll('span[class^="hljs-"]').length,
    };
  });
  must(seen.left && seen.right, 'the change drew neither a removed nor an added line');
  must(seen.left !== seen.right, `both sides are painted the same colour (${seen.left})`);
  must(/rgb.*\(2[0-9]{2}/.test(seen.left), `the removed side is not red (${seen.left})`);
  must(seen.language, 'the diff says nothing about the language it is in');
  must(seen.painted > 0, `nothing inside the diff is coloured for ${seen.language}`);
  // The middle of a comment that runs over several lines: painted a row at a
  // time it came back picked apart for keywords, which is a worse reading than
  // the grey it replaced (bw-4wcd.16).
  const inside = await diff.evaluate((el) => {
    const cell = [...el.querySelectorAll('td')].find((td) => td.textContent.includes('const used = 1;'));
    if (!cell) return null;
    return {
      comment: cell.querySelectorAll('.hljs-comment').length,
      keyword: cell.querySelectorAll('.hljs-keyword').length,
    };
  });
  must(inside !== null, 'the comment that runs over several lines is not in the diff at all');
  must(inside.comment > 0, 'a line in the middle of a comment is not drawn as a comment');
  must(inside.keyword === 0, 'a line in the middle of a comment is drawn as code');
  return `${seen.language}, ${seen.painted} coloured pieces, ${seen.left} vs ${seen.right}, comments whole`;
});

await check(2, 'a command and a file read are coloured, not one flat grey block', async () => {
  const bodies = await page.locator('pre[data-language]').all();
  const painted = [];
  for (const body of bodies) {
    const seen = await body.evaluate((el) => ({
      language: el.getAttribute('data-language'),
      spans: el.querySelectorAll('span[class^="hljs-"]').length,
    }));
    if (seen.language && seen.spans > 0) painted.push(`${seen.language}:${seen.spans}`);
  }
  must(bodies.length > 0, 'no command or read body was drawn at all');
  must(painted.length >= 2, `only ${painted.length} of ${bodies.length} bodies were coloured`);
  // Same again for a file read, which keeps its line numbers and is therefore
  // cut into lines by a different path than the diff (bw-4wcd.16).
  const inside = await page.evaluate(() => {
    const line = [...document.querySelectorAll('[data-testid="numbered-line"]')].find((el) =>
      el.textContent.includes('const used = 1;'),
    );
    if (!line) return null;
    return {
      comment: line.querySelectorAll('.hljs-comment').length,
      keyword: line.querySelectorAll('.hljs-keyword').length,
    };
  });
  must(inside !== null, 'the file read drew no line inside the comment');
  must(inside.comment > 0, 'a numbered line inside a comment is not drawn as a comment');
  must(inside.keyword === 0, 'a numbered line inside a comment is drawn as code');
  return `${painted.join(', ')}, comments whole`;
});

await check(3, 'a card named in a message is a chip that opens it', async () => {
  const mention = page.getByTestId('mention-card').first();
  await mention.waitFor();
  const id = await mention.getAttribute('data-bead-id');
  must(cardIds.includes(id), `the chip names ${id}, which is not on this board`);
  await mention.click();
  await page.waitForURL(new RegExp(`card=${id.replace('.', '\\.')}`));
  await openChat();
  return `${id} opened the card`;
});

await check(4, 'the top line says how full the conversation is', async () => {
  const chip = page.getByTestId('context-chip');
  await chip.waitFor();
  const text = (await chip.textContent()).trim();
  must(/^\d+k\/\d+k$/.test(text), `the figure reads "${text}", not used-against-total`);
  const used = Number(await chip.getAttribute('data-used'));
  const window = Number(await chip.getAttribute('data-window'));
  must(used > 0 && window > used, `${used} of ${window} is not a conversation inside its window`);
  return text;
});

await check(5, 'the count at the end of the cards opens the rest of them', async () => {
  const more = page.getByTestId('bead-chip-more').first();
  await more.waitFor();
  const hidden = Number(await more.getAttribute('data-more'));
  await more.click();
  const list = page.getByTestId('bead-chip-more-list');
  await list.waitFor({ state: 'visible' });
  const box = await list.boundingBox();
  must(box, 'the list opened with no size at all');
  must(box.x >= 0 && box.y >= 0, `the list opened off the screen at x:${Math.round(box.x)} y:${Math.round(box.y)}`);
  must(box.y + box.height <= 900 + 1 && box.x + box.width <= 1440 + 1, 'the list opened past the edge of the window');
  const drawn = await page.getByTestId('bead-chip-hidden').count();
  must(drawn === hidden, `the count says ${hidden} more and the list drew ${drawn}`);
  // Not merely present: a reader's click must land on it.
  const first = page.getByTestId('bead-chip-hidden').first();
  const at = await first.boundingBox();
  const onTop = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="bead-chip-hidden"]') !== null,
    [at.x + at.width / 2, at.y + at.height / 2],
  );
  must(onTop, 'the list is drawn but nothing else can be clicked through to it');
  await page.keyboard.press('Escape');
  return `${drawn} cards at x:${Math.round(box.x)} y:${Math.round(box.y)}`;
});

await check(6, 'a clicked chip keeps its size and draws no ring outside its edge', async () => {
  const chip = page.getByTestId('bead-chip').first();
  await chip.waitFor();
  const look = () =>
    chip.evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        w: r.width, h: r.height,
        outline: s.outlineStyle === 'none' ? '0px' : s.outlineWidth,
        shadow: s.boxShadow,
        border: s.borderColor,
      };
    });
  const before = await look();
  // A CLICK, not a focus call: what he complained about is what the mouse does,
  // and a keyboard's own focus ring is a different thing that should stay.
  await chip.click();
  const after = await look();
  must(
    Math.abs(before.w - after.w) < 0.5 && Math.abs(before.h - after.h) < 0.5,
    `the chip changed size when it was clicked (${before.w}x${before.h} to ${after.w}x${after.h})`,
  );
  must(after.outline === '0px', `it drew a ${after.outline} ring outside itself`);
  must(after.shadow === 'none', `it drew a shadow ring outside itself (${after.shadow})`);
  must(after.border !== 'rgba(0, 0, 0, 0)', 'the chip has no border of its own to brighten');
  // The half that matters: it must CHANGE. A chip that already carries a visible
  // border passes "not transparent" whether the click did anything or not, and a
  // rule hung on the browser's keyboard-only highlight does exactly nothing here
  // — the reading of this job found the check green over that very fault.
  must(
    after.border !== before.border,
    `the click brightened nothing: the border was ${before.border} and stayed ${after.border}`,
  );
  await openChat();
  return `border ${before.border} to ${after.border}, no ring, same ${Math.round(after.w)}x${Math.round(after.h)}`;
});

await check(7, 'a card chip and a report chip both draw a picture before their words', async () => {
  const icons = async (testId) => {
    const el = page.getByTestId(testId).first();
    if ((await el.count()) === 0) return null;
    return el.evaluate((node) => node.querySelectorAll('svg').length);
  };
  const card = await icons('bead-chip');
  must(card !== null, 'no card chip was drawn at all');
  must(card > 0, 'a card chip carries no picture');
  const rep = (await icons('chat-report-chip')) ?? (await icons('mention-report'));
  must(rep !== null, 'no report chip was drawn, so the two cannot be compared');
  must(rep > 0, 'a report chip carries no picture');
  return `card ${card}, report ${rep}`;
});

await check(8, 'the button that starts a chat says New Chat behind a drawn plus', async () => {
  // With no chat open the screen carries two of these buttons at once — the
  // one in the bar and the one in the middle — so this is also where a name
  // shared between two elements shows up (bw-4wcd.18).
  await page.goto(`${UI}/project?id=${project.id}&tab=chat`);
  await page.getByTestId('new-chat').waitFor();
  const named = await page.locator('[data-testid="new-chat-plus"]').count();
  must(named === 1, `${named} elements answer to the same name at once`);
  const own = await page.locator('[data-testid="new-chat-empty-plus"]').count();
  must(own === 1, `the button in the middle of the empty screen has no plus of its own`);
  const button = page.locator('[aria-label="New Chat"]').first();
  await button.waitFor();
  const words = (await button.textContent()).trim();
  must(/new chat/i.test(words), `the button reads "${words}"`);
  // The plus is a picture, not a letter of the label: typed, it rides the text's
  // own baseline and reads a size small beside the words (bw-4wcd.14).
  const plus = button.locator('[data-testid="new-chat-plus"]');
  must(await plus.count() > 0, `the button has no drawn plus, only the words "${words}"`);
  must(!words.includes('+'), `the plus is still typed into the label: "${words}"`);
  const box = await plus.first().boundingBox();
  must(box !== null && box.width > 6 && box.height > 6, 'the drawn plus takes up no room');
  await openChat();
  return `"${words}" behind a ${Math.round(box.width)}x${Math.round(box.height)} drawn plus, one name per button`;
});

await check(9, 'reading a chat leaves it where it was, and its row keeps its own time', async () => {
  const list = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="restore-row"]')].map((row) => ({
        key: row.getAttribute('data-row-key'),
        when: row.querySelector('span.font-mono')?.textContent?.trim() ?? '',
      })),
    );
  const before = await list();
  must(before.length >= 2, `only ${before.length} chats in the list; reading one cannot disturb an order of one`);
  const row = page.locator(`[data-testid="restore-row"] [data-testid="row-name"]`).nth(1);
  await row.click();
  await page.waitForTimeout(2_000);
  const after = await list();
  const order = (rows) => rows.map((r) => r.key).join(' ');
  must(order(before) === order(after), 'reading a chat reordered the list');
  const moved = before.filter((r, i) => after[i] && r.when !== after[i].when);
  must(moved.length === 0, `${moved.length} rows changed their time when one was read`);
  return `${before.length} rows, same order, same times`;
});

/* ------------------------------------------------------------------ *
 * The tenth: a real chat, typed into somewhere else while it is open.
 * ------------------------------------------------------------------ */

if (wanted(10) && process.env.NO_TERMINAL) {
  console.log('SKIP  .10 a chat also running in a terminal keeps growing — NO_TERMINAL=1 was set');
  results.push({ n: 10, what: 'terminal growth', ok: false, detail: 'not run' });
} else {
  await check(10, 'a chat also running in a terminal keeps growing inside the app', async () => {
    const external = randomUUID();
    const claude = (args) => terminalTurn(args, project.path);

    await claude(['--session-id', external, '-p', 'Reply with the single word: one. Nothing else.']);

    const opened = await (
      await fetch(`${API}/api/workbench/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'session.open',
          externalId: external,
          brand: 'claude',
          projectId: project.id,
          projectPath: project.path,
        }),
      })
    ).json();

    await page.goto(`${UI}/project?id=${project.id}&tab=chat&chat=${opened.id}`);
    const messages = () => page.locator('[data-testid="assistant-message"],[data-testid="user-message"]').count();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="assistant-message"],[data-testid="user-message"]').length > 0,
      null,
      { timeout: 60_000 },
    );
    const before = await messages();

    // The same conversation, grown from a terminal while this page stays open.
    await claude(['--resume', external, '-p', 'Reply with the single word: two. Nothing else.']);

    let after = before;
    let said = '';
    for (let i = 0; i < 60 && !/two/i.test(said); i++) {
      await page.waitForTimeout(1_000);
      after = await messages();
      said = (await page.locator('[data-testid="assistant-message"]').last().textContent()) ?? '';
    }
    must(after > before, `the chat stood at ${before} messages and never grew while the terminal wrote to it`);
    must(/two/i.test(said), `the chat grew to ${after} messages but never drew the terminal's second answer`);
    return `${before} to ${after} messages, last says "${said.trim().slice(0, 40)}"`;
  });
}

await browser.close();

/* ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} of the chat's ten reads like work.`);
if (failed.length) {
  console.error(`FAIL: ${failed.map((f) => `.${f.n}`).join(', ')}`);
  process.exit(1);
}
console.log('PASS: every one of them.');
