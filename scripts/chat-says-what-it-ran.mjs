/**
 * Whether the sentences on a command row still cover what he actually runs.
 *
 * His complaint, 2026-08-24: "whenever claude runs commands, it shows as those
 * raw commands and its difficult for reader to know what it is". The answer is
 * a table of rules in src/workbench/said-what-it-ran.ts, and a table of rules
 * is only ever as good as the record it was measured against. Every rule in it
 * was written for a shape that turned up in his own sessions; no unit test can
 * tell when his work moves on and the table quietly stops keeping up.
 *
 * So this replays every shell command in every session on this machine through
 * the real rules — not a copy of them — and answers three questions:
 *
 *  1. How many are named in English rather than drawn as raw shell?
 *  2. How many DELETE something without the sentence saying so? This is the one
 *     about safety rather than reading. A reader cannot tell a wrong sentence
 *     from a right one, so a friendly line that hid an `rm` would be worse than
 *     the raw shell it replaced.
 *  3. How long does one command cost? His ruling, 2026-08-24: "if that rule
 *     takes more than some microseconds, better to not have that rule."
 *
 * The second question is deliberately NOT asked with the rules' own backstop.
 * Asking a thing whether it agrees with itself is not a check. So the scan
 * below splits and matches its own naive way, sharing no code and no pattern
 * with the file it judges, and the verdict is read off the SENTENCE — the words
 * that reach a reader — rather than off any flag sitting beside it.
 *
 * A command no rule knows is not hidden. It draws as its own raw text, which is
 * his own ruling for that case, so he sees the `rm` with his own eyes.
 *
 *   node scripts/chat-says-what-it-ran.mjs
 *   node scripts/chat-says-what-it-ran.mjs --before
 *
 * `--before` answers the same three questions about the rows as they read
 * BEFORE any of this: the tool's name and the first sixty characters of the
 * command, which is what every row showed and what the job was opened to fix.
 * It is the same replay over the same record, so the two runs are comparable.
 *
 * SESSIONS= points it at another folder of records. Nothing is written.
 */
// The rules are TypeScript that node strips on the way in, and it prints about
// that. It is noise in front of a table.
process.removeAllListeners('warning');

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The app's files import each other by the `@/` alias, which only the bundler
// and the typechecker know. Teaching node the same thing has to happen before
// they are LINKED, not merely before they run.
import './at-alias.mjs';

const { trimInput } = await import('../src/workbench/imported-history.ts');
const { rawTitle, whatItRan } = await import('../src/workbench/said-what-it-ran.ts');

/** Read the rows as they were before this job, for the number it claims. */
const BEFORE = process.argv.includes('--before');

/**
 * What a row SHOWS for one call, and whether that is English.
 *
 * Both halves matter to the questions below. Coverage is the English half;
 * whether a delete is hidden is read off whatever is shown, English or not,
 * because a reader is warned either by a sentence that says so or by the raw
 * `rm` he can see with his own eyes.
 */
function shownOnTheRow(name, input) {
  if (!BEFORE) {
    const ran = whatItRan(name, input);
    if (ran) return { shown: ran.said, english: true };
  }
  return { shown: rawTitle(name, input), english: false };
}

/** How much of his record has to be named for this to be worth having at all. */
const NAMED_FLOOR = 80;
/** What one command may cost, in microseconds. His number, not ours. */
const EACH_US = 5;
/** How many calls are timed in one go. See `settle` for why they are batched. */
const BATCH = 2048;

// ── the independent scan ────────────────────────────────────────────────────
//
// Everything below this line is written to know nothing about how the rules
// work. It reads the head word of each piece of a command line and nothing
// cleverer, and it is tuned by one measurement only: over the 69,000 commands
// in his record it must never cry wolf, because a check that fails every day
// is a check nobody reads.

/** Words that throw work away, whatever else the command around them does. */
const THROWS_IT_AWAY = new Set(['rm', 'rmdir', 'shred', 'mkfs', 'killall', 'pkill', 'kill']);

/** Words that stand in FRONT of a command without being one. */
const IN_FRONT = new Set([
  'sudo', 'doas', 'nohup', 'setsid', 'time', 'timeout', 'nice', 'env', 'command',
  'exec', 'xargs', 'git', 'rtk', 'proxy',
]);

/** Anything a sentence could say to mean something was thrown away. */
const SAYS_SO = /delet|kill|remov|shred|threw away|throwing away|formatted|wiped|force-push/i;

/** A delete or a kill handed to a shell as a string: `sh -c 'cd x && rm -rf y'`. */
const HANDED_TO_A_SHELL = /\b(?:sh|bash|zsh|dash)\s+(?:-\w+\s+)*-\w*c\w*\s+(['"])([\s\S]*?)\1/g;

/**
 * The body of a here-document is not shell, it is the file being written.
 *
 * Two thirds of everything this scan used to flag was a python script holding a
 * variable called `rm`, or one of these very rules written into a file. Cutting
 * the body takes all of them out and loses nothing: a delete a script performs
 * when somebody LATER runs it is not a delete this command did.
 */
function withoutHeredocs(command) {
  if (command.indexOf('<<') < 0) return command;
  const kept = [];
  let ending = null;
  for (const line of command.split('\n')) {
    if (ending !== null) {
      if (line.trim() === ending) ending = null;
      continue;
    }
    kept.push(line);
    const opens = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (opens) ending = opens[2];
  }
  return kept.join('\n');
}

/** Whether a piece of a command line starts by throwing something away. */
function throwsItAway(piece) {
  const words = piece.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length && i < 4; i += 1) {
    // `mkfs.ext4` is `mkfs` wearing a filesystem's name.
    const word = (words[i].split('/').pop() ?? '').split('.')[0];
    if (THROWS_IT_AWAY.has(word)) {
      // `kill -0` sends no signal at all: it is how a script waits for a
      // process, and calling it a kill would cry wolf on every one of them.
      if (word === 'kill' && words[i + 1] === '-0') return false;
      return true;
    }
    // Only a word we KNOW stands in front of a command lets the scan look at
    // the next one. Without that, `grep rm notes.txt` reads as a delete.
    if (!IN_FRONT.has(word) && !word.startsWith('-') && !/^\d+$/.test(word) && !word.includes('=')) {
      return false;
    }
  }
  return false;
}

/**
 * A run of quoted text, which is an argument rather than a command.
 *
 * Blanked before the line is split up, because every separator this scan
 * splits on also turns up inside a `grep` pattern: `grep -iE "(delete|rm)"`
 * and `grep -n "let Some(rm) = ranges"` each leave a piece that is the bare
 * word `rm` and delete nothing whatsoever. A delete genuinely handed to a
 * shell in quotes is read separately, off the text from before this ran.
 */
const IN_QUOTES = /'[^']*'|"[^"]*"/g;

/** Whether a command line throws anything away, anywhere in it. */
function aDeleteIsInThere(command) {
  const shell = withoutHeredocs(command);
  const bare = shell.replace(IN_QUOTES, ' ');
  // `find … -delete` holds none of the words above and deletes every match;
  // `-exec rm` hides one behind an argument list.
  if (/\s-delete\b/.test(bare)) return true;
  if (/-exec(?:dir)?\s+(?:\S*\/)?rm\b/.test(bare)) return true;
  if (bare.split(/[\n;&|()`]+/).some(throwsItAway)) return true;
  for (const handed of shell.matchAll(HANDED_TO_A_SHELL)) {
    if (handed[2].replace(IN_QUOTES, ' ').split(/[\n;&|()`]+/).some(throwsItAway)) return true;
  }
  return false;
}

// ── the replay ──────────────────────────────────────────────────────────────

/** Every record this machine has kept, whatever project it belongs to. */
function everyRecord(root) {
  const found = [];
  let projects;
  try {
    projects = readdirSync(root);
  } catch {
    return found;
  }
  for (const project of projects) {
    let entries;
    try {
      entries = readdirSync(join(root, project));
    } catch {
      continue;
    }
    for (const entry of entries) if (entry.endsWith('.jsonl')) found.push(join(root, project, entry));
  }
  return found;
}

let calls = 0;
let callsNamed = 0;
let shell = 0;
let shellNamed = 0;
let deletes = 0;
let hidden = 0;
let nanos = 0n;
/** A few of each fault, so a red run says what to go and look at. */
const hiddenSample = [];
const unnamedHead = new Map();

/** Calls waiting to be named, and what the scan already knows about each. */
const waiting = [];

/**
 * Name a batch of calls, timing the naming and nothing else.
 *
 * Timed in batches rather than one at a time because a stopwatch either side of
 * a 4-microsecond call is measuring itself as much as the call. A batch also
 * matches how the browser actually uses this: a chat opens, and every tool call
 * in it is named in one pass.
 */
function settle() {
  const said = new Array(waiting.length);
  const began = process.hrtime.bigint();
  for (let i = 0; i < waiting.length; i += 1) said[i] = shownOnTheRow(waiting[i].name, waiting[i].input);
  nanos += process.hrtime.bigint() - began;

  for (let i = 0; i < waiting.length; i += 1) {
    const held = waiting[i];
    const ran = said[i];
    calls += 1;
    if (ran.english) callsNamed += 1;
    if (held.command === null) continue;

    shell += 1;
    if (ran.english) shellNamed += 1;
    else {
      const head = (held.command.trim().split(/[\s;|&]/)[0] || '?').split('/').pop();
      unnamedHead.set(head, (unnamedHead.get(head) ?? 0) + 1);
    }

    if (!held.throwsItAway) continue;
    deletes += 1;
    // Read off what the row SHOWS, which is a sentence for a command a rule
    // knows and the raw text for one it does not — where he sees the `rm` with
    // his own eyes, so nothing is hidden either.
    if (!SAYS_SO.test(ran.shown)) {
      hidden += 1;
      if (hiddenSample.length < 8) {
        hiddenSample.push(`${JSON.stringify(held.command.slice(0, 120))} → ${JSON.stringify(ran.shown)}`);
      }
    }
  }
  waiting.length = 0;
}

const SESSIONS = process.env.SESSIONS ?? join(homedir(), '.claude', 'projects');
const records = everyRecord(SESSIONS);

for (const record of records) {
  let text;
  try {
    text = readFileSync(record, 'utf8');
  } catch {
    continue;
  }
  for (const line of text.split('\n')) {
    // Cheaper than parsing every line of a record to find the few that hold a
    // call: most of them are somebody talking.
    if (!line || line.indexOf('"tool_use"') < 0) continue;
    let held;
    try {
      held = JSON.parse(line);
    } catch {
      continue;
    }
    const content = held?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
      // The very arguments the browser is given: cut where the app cuts them,
      // so what is measured here is what a reader would be shown (bw-7ks.24.6).
      const input = trimInput(typeof block.input === 'object' && block.input !== null ? block.input : {});
      const command = block.name === 'Bash' && typeof input.command === 'string' ? input.command : null;
      waiting.push({
        name: block.name,
        input,
        command,
        throwsItAway: command !== null && aDeleteIsInThere(command),
      });
      if (waiting.length >= BATCH) settle();
    }
  }
}
settle();

const namedPct = shell === 0 ? 0 : (100 * shellNamed) / shell;
const eachUs = calls === 0 ? 0 : Number(nanos) / calls / 1000;
const mark = (ok) => (ok ? '✓' : '✗');

const faults = [];
if (records.length === 0) faults.push(`no records under ${SESSIONS}`);
if (namedPct < NAMED_FLOOR) faults.push(`only ${namedPct.toFixed(1)}% named`);
if (hidden > 0) faults.push(`${hidden} deletes hidden`);
if (eachUs > EACH_US) faults.push(`${eachUs.toFixed(2)}us a command`);

console.log(
  `${records.length} records, ${calls} tool calls, ${shell} shell commands — rows as they read ${BEFORE ? 'BEFORE this job' : 'now'}\n`,
);
console.log(
  `  ${mark(namedPct >= NAMED_FLOOR)} Named in English — ${shellNamed} of ${shell} commands (${namedPct.toFixed(1)}%, floor ${NAMED_FLOOR}%). Every call: ${callsNamed} of ${calls} (${calls === 0 ? '0.0' : ((100 * callsNamed) / calls).toFixed(1)}%).`,
);
console.log(
  `  ${mark(hidden === 0)} A delete is never hidden — ${deletes} commands throw something away, ${hidden} show nothing about it on the row.`,
);
console.log(
  `  ${mark(eachUs <= EACH_US)} Costs nothing perceptible — ${eachUs.toFixed(2)}us a command, ${(Number(nanos) / 1e6).toFixed(0)}ms for the lot (ceiling ${EACH_US}us).`,
);

if (hiddenSample.length > 0) {
  console.log('\nHidden:');
  for (const one of hiddenSample) console.log(`  ${one}`);
}
if (namedPct < NAMED_FLOOR) {
  console.log('\nMost common commands no rule knows:');
  for (const [head, n] of [...unnamedHead].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(n).padStart(6)}  ${head}`);
  }
}

console.log(`\n${faults.length === 0 ? 'PASS' : `FAIL — ${faults.join('; ')}`}`);
process.exit(faults.length === 0 ? 0 : 1);
