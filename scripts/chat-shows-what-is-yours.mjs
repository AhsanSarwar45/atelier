/**
 * What a chat puts on the manager's screen before he touches a switch.
 *
 * The complaint this answers is his, 2026-08-20: "only display the status
 * messages that are relevant to the user... this rate limit event seems to be
 * for the agent. why am i being shown it." Sorting by how BAD a line is had put
 * the machine's own bookkeeping in front of him — an allowance window opening,
 * the mode a chat started in, an agent sent off and home again — and no unit
 * test could see it, because every one of those lines is correct on its own.
 * What was wrong was the set of them, over his own three days of chats.
 *
 * So this reads his real record and answers three questions, using the real
 * sorting and the real driver rather than a copy of either:
 *
 *  1. Of every machine line ever written here, which kinds are they, who is
 *     each for, and how many reach his screen unasked?
 *  2. Does any kind draw its own wire name where its sentence should be?
 *  3. Does a chat that has only just opened announce a mode or a model it has
 *     not changed?
 *
 * It exits non-zero when any of the three comes back wrong, and prints the
 * tally either way.
 *
 *   node scripts/chat-shows-what-is-yours.mjs
 *
 * STORE= points it at another record. Nothing is written; the store is opened
 * read-only, so it is safe to run against a workbench that is serving.
 */
// The record and the sorting are both experimental-ish to node — SQLite is
// behind a flag it prints about, and the sorting is TypeScript it strips on the
// way in. Both warnings are noise in front of a table.
process.removeAllListeners('warning');

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// The app's files import each other by the `@/` alias, which only the bundler
// and the typechecker know. Teaching node the same thing has to happen before
// they are LINKED, not merely before they run — so the alias is registered here
// and they are pulled in on the line after, by hand (bw-iiv6).
import './at-alias.mjs';

const { drawnRows, FAMILIES, forWhom, OFF_BY_DEFAULT } = await import('../src/workbench/machine-lines.ts');
const { KIT_SPEAKS, kitSpoke, SAID_NOTHING, WORDS } = await import('../src/workbench/machine-words.ts');
const { ClaudeDriver } = await import('../workbench/src/drivers/claude.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DATA = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
const STORE = process.env.STORE ?? join(DATA, 'kanban-ui', 'workbench.db');

const hidden = new Set(OFF_BY_DEFAULT);

/* ------------------------------------------------------------------ *
 * 1. His own record: every machine line, who it is for, what he sees.
 * ------------------------------------------------------------------ */

/**
 * The record read back into the rows a conversation draws.
 *
 * Per chat and in order, because a run of one kind folds into a single row and
 * folding across two chats would count a row that nobody has ever seen. The
 * sidecar's own event is nearly the shape the browser folds, so the two fields
 * that differ are renamed here and nothing else is invented.
 */
function linesInTheRecord() {
  const db = new DatabaseSync(STORE, { readOnly: true });
  const rows = db
    .prepare(`select session_id, seq, json from event where type in ('note', 'notice') order by session_id, seq`)
    .all();
  db.close();

  const chats = new Map();
  for (const row of rows) {
    const e = JSON.parse(row.json);
    const item =
      e.type === 'note'
        ? {
            kind: 'note',
            id: e.noteId ?? `${row.session_id}:${row.seq}`,
            rank: e.rank,
            noteKind: e.kind,
            text: e.text ?? '',
            body: e.body ?? null,
          }
        : {
            kind: 'notice',
            id: `${row.session_id}:${row.seq}`,
            text: e.text ?? '',
            family: e.family,
            audience: e.audience,
          };
    const held = chats.get(row.session_id) ?? [];
    held.push(item);
    chats.set(row.session_id, held);
  }
  return chats;
}

const chats = linesInTheRecord();

/**
 * One entry per kind AND audience, because several kinds are split by outcome:
 * an allowance window closing is his and the same window opening is not, and a
 * table that collapsed the pair would report the loud half's audience over the
 * quiet half's count.
 */
const tally = new Map();
let lines = 0;
let rowsDrawn = 0;
let rowsBefore = 0;
let rowsAll = 0;
/** Rows whose sentence is their own wire name, kept to say which chats hold them. */
const wireNamed = new Map();

for (const items of chats.values()) {
  for (const row of drawnRows(items)) {
    if (row.row !== 'machine') continue;
    const at = `${row.kind}\u0000${row.audience}`;
    const seen = tally.get(at) ?? { kind: row.kind, audience: row.audience, family: row.family, lines: 0, rows: 0, drawn: 0 };
    seen.lines += row.lines.length;
    seen.rows += 1;
    rowsAll += 1;
    lines += row.lines.length;
    if (!hidden.has(row.audience)) {
      seen.drawn += 1;
      rowsDrawn += 1;
    }
    // What the same record drew before audience existed: everything the chat
    // was loud enough to give a colour. It is here so the change has a number.
    if (row.family !== 'breathing') rowsBefore += 1;
    tally.set(at, seen);
    for (const line of row.lines) {
      if (line.text.trim() === row.kind) wireNamed.set(row.kind, (wireNamed.get(row.kind) ?? 0) + 1);
    }
  }
}

const wide = (s, n) => String(s).padEnd(n);
const num = (n, w) => String(n).padStart(w);

console.log(`Read ${STORE}`);
console.log(`${chats.size} chats, ${lines} machine lines, folded to ${rowsAll} rows.\n`);
console.log(`  ${wide('kind', 34)}${wide('for', 9)}${wide('family', 12)}${num('lines', 6)}${num('rows', 6)}${num('drawn', 7)}`);
for (const seen of [...tally.values()].sort((a, b) => b.lines - a.lines || a.kind.localeCompare(b.kind))) {
  console.log(
    `  ${wide(seen.kind, 34)}${wide(seen.audience, 9)}${wide(seen.family, 12)}${num(seen.lines, 6)}${num(seen.rows, 6)}${num(seen.drawn, 7)}`,
  );
}

const share = rowsAll === 0 ? 0 : Math.round((rowsDrawn / rowsAll) * 100);
console.log(
  `\n  Drawn before he touches a switch: ${rowsDrawn} of ${rowsAll} rows (${share}%). Sorted by loudness alone it was ${rowsBefore}.`,
);

/**
 * The first verdict, and the one his complaint was about.
 *
 * Written as the six things he pointed at on 2026-08-20 rather than as a sum
 * over the audience table, because a check that reads the same table the screen
 * reads can only ever agree with it. This is the ruling itself, in his terms: a
 * window that is merely open, an agent going and coming home unharmed, a rule
 * of his own firing, the app saying it woke a chat up. Re-rule any of them and
 * this goes red.
 */
const HIS_COMPLAINT = [
  ['rate_limit_event', 'detail', 'an allowance window that is merely open'],
  ['system/task_started', 'detail', 'an agent being sent off'],
  ['system/task_notification', 'detail', 'an agent coming home unharmed'],
  ['system/hook_started', 'detail', 'a rule of his own starting'],
  ['system/hook_progress', 'detail', 'a rule of his own working'],
  ['system/hook_response', 'note', 'a rule of his own complaining'],
  ['system/status', 'detail', 'the status ping on every request'],
  ['system/memory_recall', 'detail', 'memory being recalled'],
];
const leaked = HIS_COMPLAINT.filter(([kind, rank]) => !hidden.has(forWhom(kind, rank)));

/* ------------------------------------------------------------------ *
 * 2. The live driver: does every kind draw a sentence?
 * ------------------------------------------------------------------ */

/** The body of one function of the driver's source, by the name it is declared under. */
function bodyOf(source, declaration, ends) {
  const at = source.indexOf(declaration);
  if (at < 0) throw new Error(`the driver no longer declares ${declaration.trim()}`);
  const shut = source.indexOf(ends, at);
  return source.slice(at, shut < 0 ? source.length : shut);
}

/**
 * Every kind of message that can end up as a line in the conversation.
 *
 * Read out of the driver rather than listed here, because a list would go stale
 * the first time a kind was added over there — which is how two of them came to
 * print `system/task_updated` where their sentence should be (bw-6jq5.3).
 *
 * Three places know of one, and all three are asked. The sorting function names
 * the kinds somebody has written a sentence for. The one that follows sent-off
 * work names more, and the ones it does not finish with fall through to a line.
 * And his own record names whatever the kit has actually sent this machine,
 * including kinds nobody here has ever heard of — which is the only place the
 * two nameless ones showed up.
 */
function kindsThatReachALine(seenInTheRecord) {
  const source = readFileSync(join(REPO, 'workbench', 'src', 'drivers', 'claude.ts'), 'utf8');
  const written = Array.from(
    bodyOf(source, 'function noteBody(', '\n}\n').matchAll(/case '([\w/_]+)':/g),
  ).map((m) => m[1]);
  const tasks = Array.from(
    bodyOf(source, '  private sawTask(', '\n  private ').matchAll(/case '([\w_]+)':/g),
  ).map((m) => `system/${m[1]}`);
  return Array.from(new Set([...written, ...tasks, ...seenInTheRecord]));
}

/** One wire message per kind, shaped the way the driver reads a kind back. */
function wireFor(kind) {
  const at = kind.indexOf('/');
  return at < 0 ? { type: kind } : { type: kind.slice(0, at), subtype: kind.slice(at + 1) };
}

/** Every note one driver emits while it is fed these messages. */
function notesFrom(messages) {
  const said = [];
  const driver = new ClaudeDriver();
  driver.emit = (e) => {
    if (e.type === 'note') said.push(e);
  };
  const broke = [];
  for (const m of messages) {
    try {
      driver.draw(m);
    } catch (err) {
      broke.push(`${m.subtype ?? m.type}: ${err.message}`);
    }
  }
  return { said, broke };
}

// Only the kit's own side of the record is asked back of the driver: a line
// the app wrote itself (`app/notice`) never passed through a driver at all, and
// feeding one to this driver would invent a kind it has never been sent.
const known = kindsThatReachALine(
  [...tally.values()].map((seen) => seen.kind).filter((k) => k.startsWith('system/')),
);
const { said: everyNote, broke } = notesFrom(known.map(wireFor));
/**
 * A line that says its own name is a line that says nothing (bw-6jq5.3).
 *
 * Only the name is judged, not an empty sentence: these messages carry no
 * fields, so a kind that says what its message said says nothing here for a
 * reason of this check's own making.
 */
const nameless = everyNote.filter((n) => {
  const words = String(n.text ?? '').trim();
  const tail = n.kind.includes('/') ? n.kind.slice(n.kind.indexOf('/') + 1) : n.kind;
  return words === n.kind || words === tail;
});

/* ------------------------------------------------------------------ *
 * 3. The live driver: what a chat says about itself the moment it opens.
 * ------------------------------------------------------------------ */

const OPENING = [
  { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5', cwd: '/tmp', permissionMode: 'default' },
  { type: 'system', subtype: 'status', permissionMode: 'default' },
  { type: 'system', subtype: 'status', permissionMode: 'default' },
];
const SWITCHED = [...OPENING, { type: 'system', subtype: 'status', permissionMode: 'bypassPermissions' }];

const modeRows = (messages) =>
  notesFrom(messages).said.filter((n) => n.kind === 'mode' || n.kind === 'model').length;

const onOpening = modeRows(OPENING);
const afterSwitch = modeRows(SWITCHED) - onOpening;

/* ------------------------------------------------------------------ *
 * 4. The kit's own type file: is every kind, and every state, named?
 * ------------------------------------------------------------------ */

/**
 * The kit's types, read as text.
 *
 * As text on purpose. The point is to catch the day the kit grows a state
 * nobody here has read — and a check that imported the types would compile
 * happily against exactly that, because a new member of a union is not a type
 * error anywhere until something switches on it.
 */
const KIT = readFileSync(
  join(REPO, 'workbench', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.d.ts'),
  'utf8',
);

/** One type declaration out of the kit's file, whole. */
function declared(name) {
  const opens = `declare type ${name} = `;
  const at = KIT.indexOf(opens);
  if (at < 0) return null;
  // A block of fields ends on its own brace; a one-line alias ends on the first
  // semicolon. Told apart by what follows the equals sign, because a block's
  // first field also ends in a semicolon and cutting there loses the rest.
  const body = at + opens.length;
  const shut = KIT[body] === '{' ? KIT.indexOf('\n};', body) : KIT.indexOf(';', body);
  return shut < 0 ? KIT.slice(body) : KIT.slice(body, shut);
}

/** Every string the kit spells out for one property, following one alias. */
function statesTheKitDeclares(typeName, field) {
  const block = declared(typeName);
  if (block === null) return null;
  const at = block.search(new RegExp(`\\n[ \\t]*${field}\\??:`));
  if (at < 0) return null;
  const said = block.slice(at, block.indexOf(';', at));
  const spelled = Array.from(said.matchAll(/'([^']+)'/g)).map((m) => m[1]);
  if (spelled.length > 0) return spelled;
  // `status: SDKStatus` — the literals are one hop away.
  const alias = said.match(/:\s*([A-Za-z][\w.]*)/);
  const followed = alias ? declared(alias[1].replace(/^\w+\./, '')) : null;
  return followed === null ? null : Array.from(followed.matchAll(/'([^']+)'/g)).map((m) => m[1]);
}

/**
 * Every kind of message the kit says it can send.
 *
 * Read off the SDKMessage union and then out of each member's own declaration,
 * so a kind the kit adds is a kind this check knows about the day it lands.
 */
function kindsTheKitDeclares() {
  const union = declared('SDKMessage');
  const members = Array.from(union.matchAll(/\b(SDK\w+)\b/g)).map((m) => m[1]).filter((n) => n !== 'SDKMessage');
  const kinds = new Set();
  const follow = (name, depth) => {
    const block = declared(name);
    if (block === null || depth > 2) return;
    const type = block.match(/^\s*type: '([^']+)'/m);
    if (!type) {
      // An alias over more members — SDKResultMessage is two.
      for (const inner of Array.from(block.matchAll(/\b(SDK\w+)\b/g)).map((m) => m[1])) {
        if (inner !== name) follow(inner, depth + 1);
      }
      return;
    }
    const subtype = block.match(/^\s*subtype: '([^']+)'/m);
    kinds.add(type[1] === 'system' && subtype ? `system/${subtype[1]}` : type[1]);
  };
  for (const name of members) follow(name, 0);
  return [...kinds];
}

/**
 * Kinds that never become a machine line, because the chat draws them as
 * something better. Each one is answered somewhere else on the screen, and the
 * reason is written beside it so that "it does not appear" can be told from
 * "nobody thought about it" — which is the whole fault this check exists for.
 */
const DRAWN_ELSEWHERE = {
  assistant: "the agent's own words, drawn as the reply",
  user: 'what he typed, drawn as his own message',
  result: 'the end of a turn, drawn on the chip that says what the chat is doing',
  stream_event: 'the reply arriving a word at a time',
  tool_progress: 'how long a call has been running, drawn on the call',
  'system/init': 'the chat opening, which is the chat existing',
  'system/task_progress': "what a sent-off agent is doing, drawn on that agent's own row",
};

const kitKinds = kindsTheKitDeclares();
const cased = new Set(known);
const undecided = kitKinds.filter(
  (kind) => !cased.has(kind) && !(kind in SAID_NOTHING) && !(kind in DRAWN_ELSEWHERE),
);

/** A state the kit spells out that this app has no word and no ruling for. */
const unnamed = [];
/** A state this app names that the kit no longer declares, and never called its own. */
const invented = [];
for (const [kind, words] of Object.entries(WORDS)) {
  const ours = new Set(Object.keys(words.ours));
  const theirs = words.kit === null ? null : statesTheKitDeclares(words.kit.type, words.kit.field);
  if (words.kit !== null && theirs === null) {
    unnamed.push(`${kind}: the kit no longer declares ${words.kit.type}.${words.kit.field}`);
    continue;
  }
  for (const state of theirs ?? []) {
    if (state !== 'null' && !(state in words.states)) unnamed.push(`${kind}.${state}`);
  }
  for (const state of Object.keys(words.states)) {
    if (!ours.has(state) && !(theirs ?? []).includes(state)) invented.push(`${kind}.${state}`);
  }
}

/* ------------------------------------------------------------------ *
 * 5. Every kind in every state, through the real driver: whose words?
 * ------------------------------------------------------------------ */

/**
 * A word that could only have come off the wire.
 *
 * Not a list of the kit's own strings, because half of them are ordinary
 * English a sentence is entitled to — a helper really did fail, a rule really
 * did run. What no sentence ever wants is a word SHAPED like an identifier:
 * one with an underscore inside it, or a capital letter inside it. That is
 * exactly the class that reached his screen — `allowed_warning`, `PreToolUse`,
 * `error_max_turns`, `api_retry` — and no English word is ever mistaken for it.
 */
const OFF_THE_WIRE = /\b[a-z]+(?:_[a-z]+)+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/;

/** Every kind and state the table names, one message each, through the driver. */
const everyState = [];
for (const [kind, words] of Object.entries(WORDS)) {
  for (const state of Object.keys(words.states)) everyState.push({ kind, state, words });
}

const spoke = [];
for (const { kind, state, words } of everyState) {
  const { said } = notesFrom([words.sample(state)]);
  const note = said.find((n) => n.kind === kind) ?? null;
  spoke.push({ kind, state, note, want: words.states[state] });
}

/** A drawn line still carrying a word from the wire. */
const wired = spoke.filter(({ note }) => note && OFF_THE_WIRE.test(String(note.text)));
/** A state that draws nothing at all, so nobody can read what happened. */
const silent = spoke.filter(({ note }) => note === null);
/** A state whose line lands in front of the wrong reader. */
const misfiled = spoke.filter(
  ({ note, want }) => note && (note.audience ?? forWhom(note.kind, note.rank)) !== want.who,
);

/**
 * And the same question of the record: every row it draws, in whose words.
 *
 * Every row, not only the ones switched on, because the switch is his and the
 * English is not conditional on it. A sentence is written down when the line is
 * written, so a fixed wording never reaches a chat that already holds one
 * (bw-x6hb) — which is why old lines are restated as they are drawn, and why
 * this counts what comes out of the drawing rather than what went in.
 */
const drawnWired = [];
for (const [session, items] of chats.entries()) {
  for (const row of drawnRows(items)) {
    if (row.row !== 'machine') continue;
    for (const line of row.lines) {
      const wire = OFF_THE_WIRE.exec(line.text);
      if (wire) drawnWired.push({ session, kind: row.kind, word: wire[0], text: line.text });
    }
  }
}
/** Which kinds they are, since one bad sentence is usually hundreds of rows. */
const wiredKinds = [...new Set(drawnWired.map((d) => `${d.kind} (${d.word})`))];


/* ------------------------------------------------------------------ *
 * 6. The kit talking in the chat's own voice.
 * ------------------------------------------------------------------ */

/**
 * The openings the kit declares for its own sentences, read out of the same
 * file and for the same reason: these are the lines it writes INTO a
 * conversation rather than about one, so nothing about them has a kind on it
 * and the sentence is the only thing to go on. The kit publishes four lists of
 * them and tells a consumer to route each list somewhere different; this app
 * is that consumer (bw-iiv6.12).
 */
function openingsTheKitDeclares(name) {
  const opens = `export declare const ${name}: readonly [`;
  const at = KIT.indexOf(opens);
  if (at < 0) return null;
  const ends = KIT.indexOf('];', at);
  const body = KIT.slice(at + opens.length, ends);
  return Array.from(body.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)).map((m) =>
    (m[1] ?? m[2]).replace(/\\(.)/g, '$1'),
  );
}

/** An opening the kit declares that no sentence here recognises. */
const unspoken = [];
/** An opening this app watches for that the kit has stopped declaring. */
const dropped = [];
/** A sentence of the kit's own that draws without a family or without a reader. */
const unfiled = [];

for (const spoken of KIT_SPEAKS) {
  const theirs = spoken.kit === null ? null : openingsTheKitDeclares(spoken.kit);
  if (spoken.kit !== null && theirs === null) {
    dropped.push(`${spoken.kind}: the kit no longer declares ${spoken.kit}`);
    continue;
  }
  for (const opening of theirs ?? []) {
    if (kitSpoke(`${opening} — and the rest of the line`) !== spoken.kind) unspoken.push(`${spoken.kit}: ${opening}`);
  }
  for (const opening of spoken.opens) {
    if (theirs !== null && !theirs.includes(opening)) dropped.push(`${spoken.kind}: ${opening}`);
  }
  // And the whole way through, as a chat draws it: the sentence must come back
  // as the machine talking, with a family and a reader of its own.
  for (const opening of spoken.opens) {
    const rows = drawnRows([
      { kind: 'message', id: `spoken-${opening}`, role: 'assistant', text: `${opening} · at 3:50pm`, images: [], done: true, parentId: null },
    ]);
    const row = rows[0];
    if (row?.row !== 'machine' || row.kind !== spoken.kind) unfiled.push(`${spoken.kind}: ${opening} draws as an ordinary answer`);
    else if (!FAMILIES.includes(row.family)) unfiled.push(`${spoken.kind}: ${opening} has no family`);
  }
}

/**
 * The same question of his own record: how many of these he has been sent, and
 * how many of them a chat now draws as what they are.
 *
 * Read from the chat's own messages rather than from the machine's, because
 * that is the whole of the fault — they arrive on the side of the record that
 * holds his answers.
 */
function spokenInTheRecord() {
  const db = new DatabaseSync(STORE, { readOnly: true });
  const rows = db.prepare('select session_id, role, text, at from message order by session_id, at').all();
  db.close();
  const chats = new Map();
  for (const row of rows) {
    const held = chats.get(row.session_id) ?? [];
    held.push({
      kind: 'message',
      id: `${row.session_id}:${held.length}`,
      role: row.role,
      text: row.text ?? '',
      images: [],
      done: true,
      parentId: null,
    });
    chats.set(row.session_id, held);
  }
  let lines = 0;
  let rows_ = 0;
  let his = 0;
  const chatsHolding = new Set();
  const byKind = new Map();
  for (const [id, items] of chats) {
    for (const row of drawnRows(items)) {
      if (row.row !== 'machine' || !row.kind.startsWith('kit/')) continue;
      lines += row.lines.length;
      rows_ += 1;
      chatsHolding.add(id);
      if (!hidden.has(row.audience)) his += 1;
      byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + row.lines.length);
    }
  }
  return { lines, rows: rows_, his, chats: chatsHolding.size, byKind };
}

const spokenHere = spokenInTheRecord();

console.log(
  `\n  The kit talking in a chat's own voice: ${spokenHere.lines} sentences in ${spokenHere.chats} chats, folded to ${spokenHere.rows} rows, ${spokenHere.his} of them his.`,
);
for (const [kind, count] of [...spokenHere.byKind.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${wide(kind, 34)}${wide(forWhom(kind, 'note'), 9)}${num(count, 6)}`);
}

/* ------------------------------------------------------------------ *
 * The verdicts.
 * ------------------------------------------------------------------ */

const mark = (ok) => (ok ? '✓' : '✗');
const faults = [];

if (leaked.length > 0) faults.push(`${leaked.length} kinds on the machine's own side are drawn unasked`);
if (nameless.length > 0) faults.push(`${nameless.length} kinds draw their own wire name`);
if (broke.length > 0) faults.push(`${broke.length} kinds crashed the driver`);
if (undecided.length > 0) faults.push(`${undecided.length} kinds the kit sends, nobody has decided about`);
if (unnamed.length > 0) faults.push(`${unnamed.length} states the kit declares have no words here`);
if (invented.length > 0) faults.push(`${invented.length} states are named here that the kit does not declare`);
if (wired.length > 0) faults.push(`${wired.length} states draw a word off the wire`);
if (silent.length > 0) faults.push(`${silent.length} states draw no line at all`);
if (misfiled.length > 0) faults.push(`${misfiled.length} states land in front of the wrong reader`);
if (unspoken.length > 0) faults.push(`${unspoken.length} sentences the kit speaks are unrecognised here`);
if (dropped.length > 0) faults.push(`${dropped.length} sentences are watched for that the kit no longer speaks`);
if (unfiled.length > 0) faults.push(`${unfiled.length} of the kit's own sentences draw as ordinary answers`);
if (drawnWired.length > 0) faults.push(`${drawnWired.length} rows of the record draw a word off the wire`);
if (wireNamed.size > 0) {
  faults.push(`${[...wireNamed.values()].reduce((n, c) => n + c, 0)} rows of the record draw their own wire name`);
}
if (onOpening !== 0) faults.push(`a chat that just opened announced its mode ${onOpening} times`);
if (afterSwitch !== 1) faults.push(`switching the mode said so ${afterSwitch} times, not once`);

console.log('');
console.log(
  `  ${mark(leaked.length === 0)} Nothing on the machine's own side reaches his screen unasked.${
    leaked.length === 0 ? '' : ` — ${leaked.map((s) => s.kind).join(', ')}`
  }`,
);
console.log(
  `  ${mark(nameless.length === 0)} All ${known.length} kinds the driver knows draw a sentence, not their own name.${
    nameless.length === 0 ? '' : ` — ${[...new Set(nameless.map((n) => n.kind))].join(', ')}`
  }`,
);
console.log(
  `  ${mark(undecided.length === 0 && unnamed.length === 0 && invented.length === 0)} Every kind and state the kit declares is named — ${kitKinds.length} kinds, ${everyState.length} states over ${Object.keys(WORDS).length} of them.${
    [...undecided, ...unnamed, ...invented].length === 0 ? '' : ` — ${[...undecided, ...unnamed, ...invented].join(', ')}`
  }`,
);
console.log(
  `  ${mark(wired.length === 0 && silent.length === 0)} No state draws a word off the wire, and none draws nothing.${
    [...wired, ...silent].length === 0 ? '' : ` — ${[...wired, ...silent].map((s) => `${s.kind}.${s.state}`).join(', ')}`
  }`,
);
console.log(
  `  ${mark(misfiled.length === 0)} Every state lands in front of the reader it was ruled for.${
    misfiled.length === 0 ? '' : ` — ${misfiled.map((s) => `${s.kind}.${s.state}`).join(', ')}`
  }`,
);
console.log(
  `  ${mark(onOpening === 0 && afterSwitch === 1)} A chat that just opened announces no mode; switching it says so once. — opened ${onOpening}, switched ${afterSwitch}`,
);
console.log(
  `  ${mark(unspoken.length === 0 && dropped.length === 0 && unfiled.length === 0)} Every sentence the kit speaks in the chat's own voice is filed by what it means.${
    [...unspoken, ...dropped, ...unfiled].length === 0 ? '' : ` — ${[...unspoken, ...dropped, ...unfiled].join(', ')}`
  }`,
);
console.log(
  `  ${mark(drawnWired.length === 0 && wireNamed.size === 0)} No row of his real record draws a wire word, however old the line is — all ${rowsAll} of them.${
    drawnWired.length === 0 && wireNamed.size === 0
      ? ''
      : ` — ${[...wiredKinds, ...wireNamed.keys()].join(', ')}`
  }`,
);
if (broke.length > 0) console.log(`  ${mark(false)} The driver threw on: ${broke.join('; ')}`);

console.log(`\n${faults.length === 0 ? 'PASS' : `FAIL — ${faults.join('; ')}`}`);
process.exit(faults.length === 0 ? 0 : 1);
