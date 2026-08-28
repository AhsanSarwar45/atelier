/**
 * What a tool call DID, in the words the manager would use for it.
 *
 * The complaint this answers is his, 2026-08-24: "whenever claude runs
 * commands, it shows as those raw commands and its difficult for reader to know
 * what it is… it will say that in plain language, for example 'Closed bead
 * efd-dfd'". Seven of every ten calls a chat makes is a shell command, and
 * every one of them drew as its own shell, cut at sixty characters — so the row
 * a reader most wants to skim was the one he had to parse.
 *
 * Three things were measured over his own record before any rule was written
 * here — 2,740 sessions, 110,373 shell commands — and each one decided a rule:
 *
 *  - 81.6% of commands are a chain rather than a command, so naming the first
 *    word names the wrong thing. 24.8% open with a `cd`, which is WHERE a
 *    command ran and never WHAT it did, so it never becomes a stage.
 *  - 42.1% run past two hundred characters. Joining every stage of those prints
 *    a title longer than the command it replaced, so at most three are named
 *    and the rest are counted.
 *  - 1.7% have nothing nameable anywhere in them. Those come back null and the
 *    caller draws exactly what it drew before, which is the manager's own
 *    ruling: "for commands which don't fall into our categorizer, we just show
 *    the raw commands as they are currently."
 *
 * The one rule that is about safety rather than reading: a command that deletes,
 * kills or force-pushes says so, wherever in the chain it sits. `rm` appears
 * 547 times in that record, `pkill` 176, `kill` 161, and they are usually not
 * the first thing on the line. A friendly sentence that hid one would be worse
 * than the raw shell it replaced, because a reader cannot tell a wrong sentence
 * from a right one. So a grave stage always takes one of the three shown slots.
 *
 * Nothing is imported here at run time — the same reason `machine-words.ts`
 * imports nothing — so `scripts/chat-says-what-it-ran.mjs` can replay the real
 * table over the real record instead of keeping a copy of it that goes stale.
 * What each kind LOOKS like is next door in `ran-look.ts`, and that split is
 * load-bearing rather than tidy: no icon and no Tailwind class is named here.
 */

import { isCodeModeEnvelope, normalizeCommands } from './command-normalization.ts';
import { normalizeServiceAction } from './service-action.ts';

/**
 * The kinds a call can be. The kind decides the mark and the colour, so these
 * are what a reader tells apart at a glance rather than every verb there is.
 */
export type RanKind =
  | 'board'
  | 'vcs'
  | 'search'
  | 'read'
  | 'edit'
  | 'build'
  | 'test'
  | 'lint'
  | 'run'
  | 'net'
  | 'system'
  | 'data'
  | 'wait'
  | 'script'
  | 'agent'
  | 'web'
  | 'grave';

export const RAN_KINDS: RanKind[] = [
  'board',
  'vcs',
  'search',
  'read',
  'edit',
  'build',
  'test',
  'lint',
  'run',
  'net',
  'system',
  'data',
  'wait',
  'script',
  'agent',
  'web',
  'grave',
];

export interface Ran {
  /** The sentence. Starts with a verb; the object inside it is kept verbatim. */
  said: string;
  /** Which kind the mark and the colour come from. */
  kind: RanKind;
  /** True when the command deletes, kills, force-pushes or overwrites. */
  grave: boolean;
}

/** One thing a chain did, before the chain is written out as a sentence. */
interface Stage {
  text: string;
  kind: RanKind;
  grave: boolean;
  /** The invocation only reads metadata or previews work; it executes no verb. */
  intentOnly?: boolean;
}

/** How many links of a chain are read at all. A guard, not a feature. */
const MOST_LINKS = 24;

/** How many are named before the rest are counted. */
const MOST_SHOWN = 3;

/** Heads whose transport grammar command-normalization knows how to peel. */
const COMMAND_ENVELOPE = /^\s*(?:\/\S*\/)?(?:bash|sh|zsh|dash|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|env|sudo|doas|command|exec|nohup|setsid|nice|timeout|ssh|docker|podman|kubectl|npx|bunx|pnpm|yarn|rtk)\b/i;
const SETTING_ENVELOPE = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+(?:\/\S*\/)?(?:bash|sh|zsh|dash|env|sudo|doas|command|exec|nohup|setsid|nice|timeout|ssh|docker|podman|kubectl|npx|bunx|pnpm|yarn|rtk)\b/i;
const CODE_MODE_START = /^\s*(?:\/\/\s*@exec\b|const\b|let\b|var\b|await\b)/;

/** How long a quoted pattern or a URL may run inside a sentence. */
const OBJECT = 44;

// ---------------------------------------------------------------------------
// Taking a command apart
// ---------------------------------------------------------------------------

/**
 * Where each link of a chain ends: at an unquoted `&&`, `||`, `;`, `|` or
 * newline.
 *
 * Walked a character at a time rather than split by a regex, and the reason is
 * this repo's own board: work reaches it as
 * `job under <goal> --do "what to do|how we know it is done"`, and a regex
 * split that straight down the middle of his sentence and reported the second
 * half as another thing the command did. A single `&` is left alone so `2>&1`
 * stays part of the command it belongs to.
 */
interface CommandLink {
  text: string;
  /** True only when this command consumes the previous command's pipe. */
  piped: boolean;
}

function commandLinks(command: string): CommandLink[] {
  const out: CommandLink[] = [];
  let start = 0;
  let quote = 0;
  let piped = false;
  for (let i = 0; i < command.length; i++) {
    const c = command.charCodeAt(i);
    if (quote) {
      if (c === 92 && quote === 34) i++;
      else if (c === quote) quote = 0;
      continue;
    }
    if (c === 39 || c === 34) {
      quote = c;
      continue;
    }
    if (c === 92) {
      i++;
      continue;
    }
    if (c === 59 || c === 10 || c === 124 || (c === 38 && command.charCodeAt(i + 1) === 38)) {
      out.push({ text: command.slice(start, i), piped });
      const doubled = (c === 124 || c === 38) && command.charCodeAt(i + 1) === c;
      piped = c === 124 && !doubled;
      if (doubled) i++;
      start = i + 1;
    }
  }
  out.push({ text: command.slice(start), piped });
  return out;
}

function links(command: string): string[] {
  return commandLinks(command).map((link) => link.text);
}

/** `FOO=bar` — a setting in front of a command rather than the command. */
const SETTING = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Wrappers that say nothing about what ran. `timeout` and `nice` swallow a
 * number as well, and `rtk` is the manager's own proxy — `rtk git status` is a
 * `git status` and must read as one (1,315 of them in the record).
 */
const PASSES_THROUGH: Record<string, number> = {
  sudo: 0,
  time: 0,
  setsid: 0,
  nohup: 0,
  command: 0,
  stdbuf: 0,
  exec: 0,
  xargs: 0,
  rtk: 0,
  'cargo-lim': 0,
  timeout: 1,
  nice: 1,
  ionice: 1,
};

/** `rtk`'s own commands, which are about the proxy rather than through it. */
const RTK_OWN = ['gain', 'discover'];

/**
 * Words that shape what came before them rather than doing something of their
 * own. After a real stage they are dropped; on their own they still count.
 */
const TRIMMERS = [
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'jq',
  'column',
  'tee',
  'less',
  'more',
  'nl',
  'rev',
  'tac',
  'awk',
  'sed',
  'grep',
  'rg',
];

/** Words that never did anything a reader cares about. */
const PLUMBING = ['cd', 'echo', 'printf', 'export', 'set', 'test', 'true', 'false', 'env', 'pwd', 'source', '.', ':'];

/** Every shell word in a link, with quotes removed after they have done their
 * grouping work. Quotes may begin in the middle of a word (`--notes='a b'`),
 * which a token regex cannot parse without turning its contents into flags. */
function words(link: string): string[] {
  const out: string[] = [];
  let word = '';
  let quote = '';
  let began = false;
  const push = () => {
    if (began) out.push(word);
    word = '';
    began = false;
  };
  for (let at = 0; at < link.length; at += 1) {
    const char = link[at]!;
    if (quote) {
      if (char === '\\' && quote === '"' && at + 1 < link.length) {
        word += link[++at]!;
      } else if (char === quote) {
        quote = '';
      } else {
        word += char;
      }
      began = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      began = true;
    } else if (char === '\\' && at + 1 < link.length) {
      word += link[++at]!;
      began = true;
    } else if (/\s/.test(char)) {
      push();
    } else {
      word += char;
      began = true;
    }
  }
  push();
  return out;
}

/**
 * The words of a link with what is not the command taken off the front:
 * `BEADS_WEB_PORT=3011 npx next dev` is a `next dev`, and `(cd x && y)` opens
 * with a bracket glued to the command.
 *
 * Done a word at a time rather than by a regex over the string, because the
 * regex that did it — a setting repeated one-or-more times, each ending in a
 * run of non-space — backtracked its way to 3.6 of the 17 microseconds his
 * longest command cost.
 */
function stripped(argv: string[]): string[] {
  if (!argv.length) return argv;
  let rest = argv;
  const open = rest[0]!.charAt(0);
  if (open === '(' || open === '{') {
    rest = rest[0]!.length === 1 ? rest.slice(1) : [rest[0]!.slice(1), ...rest.slice(1)];
  }
  let i = 0;
  while (i < rest.length && SETTING.test(rest[i]!)) i++;
  return i ? rest.slice(i) : rest;
}

/** The command's own name, without the folders that led to it. */
function named(word: string): string {
  const cut = word.lastIndexOf('/');
  return cut < 0 ? word : word.slice(cut + 1);
}

/** A word that sends output somewhere: `>out.log`, `2>&1`, `<in.txt`. */
function redirects(word: string): boolean {
  return word.indexOf('>') >= 0 || word.indexOf('<') >= 0;
}

/** Every word after `from` that is an argument: no flags, nothing past a `>`. */
function objects(argv: string[], from: number): string[] {
  const out: string[] = [];
  for (let i = from; i < argv.length; i++) {
    const w = argv[i]!;
    if (redirects(w)) break;
    if (w.charAt(0) === '-') continue;
    out.push(w);
  }
  return out;
}

/** The first argument after `from`, or empty when there is none. */
function object(argv: string[], from: number): string {
  return objects(argv, from)[0] ?? '';
}

/** Whether a flag was given, in either of its spellings. */
function has(argv: string[], ...flags: string[]): boolean {
  for (const w of argv) {
    for (const f of flags) {
      if (w === f) return true;
      if (f.length === 2 && f.charAt(0) === '-' && w.charAt(0) === '-' && w.charAt(1) !== '-' && w.indexOf(f.charAt(1)) > 0) {
        return true;
      }
    }
  }
  return false;
}

/** A path as a reader knows it: the last two segments, and no trailing slash. */
function place(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const parts = clean.split('/');
  if (parts.length <= 2) return clean;
  return parts.slice(-2).join('/');
}

/** Whether a path says anything a reader did not already know. */
function worthNaming(path: string): boolean {
  return path !== '' && path !== '.' && path !== './' && path !== '*' && path.charAt(0) !== '$';
}

/** The last segment alone — a folder's own name. */
function leaf(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? path;
}

/** Cut to `OBJECT` characters rather than letting a pattern run off the row. */
function brief(text: string, most = OBJECT): string {
  return text.length > most ? `${text.slice(0, most - 1)}…` : text;
}

/** Lowercased first letter, for a stage written after "then". */
function joined(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// The grave verbs
// ---------------------------------------------------------------------------

/**
 * What a command does that a reader must not learn about afterwards, and the
 * words for it. Read before anything else and never dropped.
 */
const GRAVE: Record<string, { verb: string; alone: string }> = {
  rm: { verb: 'Deleted', alone: 'Deleted files' },
  rmdir: { verb: 'Deleted', alone: 'Deleted a folder' },
  shred: { verb: 'Shredded', alone: 'Shredded a file' },
  dd: { verb: 'Overwrote', alone: 'Overwrote a disk' },
  mkfs: { verb: 'Formatted', alone: 'Formatted a disk' },
  truncate: { verb: 'Truncated', alone: 'Truncated a file' },
  kill: { verb: 'Killed', alone: 'Killed a process' },
  pkill: { verb: 'Killed', alone: 'Killed a process' },
  killall: { verb: 'Killed', alone: 'Killed a process' },
};

/**
 * A grave verb anywhere in a command, however deeply it is nested.
 *
 * Reading the chain link by link finds most of them. This finds the rest, and
 * measuring his record is what said it was needed: 306 commands that delete or
 * kill hid the verb from a proper read — inside `sh -c 'cd x && rm -f y'`,
 * behind an `xargs`, as `git rm`, or in the body of a here-document, where the
 * body is not shell at all and a stray apostrophe in it swallows everything
 * after it. So this looks for the verb wherever a command can start, rather
 * than parsing.
 *
 * It is deliberately eager. A sentence that says "deletes files" about a line
 * that did not is a small annoyance the reader can settle by opening the row.
 * One that stays quiet about a line that did is the fault this whole file
 * exists to prevent, and he would have no way of catching it.
 */
const GRAVE_ANYWHERE =
  /(?:^|[\n;&|(`"']|--\s|-exec(?:dir)?\s|\b(?:then|do|else)\s)\s*(?:(?:sudo|nohup|setsid|time|git|xargs|timeout|nice|docker|kubectl)\s+(?:-\S+\s+|\d+\s+)*){0,3}(rm|rmdir|shred|mkfs|killall|pkill|kill)\s+(?!-0\b)/;

/**
 * What the backstop found, said twice: once as a thing that was done, for a
 * chain, and once as something a script goes on doing, for a script. Written
 * out rather than turned from one into the other, which is how "stop" became
 * "Stoped" the first time round.
 */
const GRAVE_BACKSTOP: Record<string, { did: string; does: string }> = {
  rm: { did: 'Deleted files', does: 'deletes files' },
  rmdir: { did: 'Deleted a folder', does: 'deletes a folder' },
  shred: { did: 'Shredded a file', does: 'shreds a file' },
  mkfs: { did: 'Formatted a disk', does: 'formats a disk' },
  kill: { did: 'Killed a process', does: 'kills a process' },
  pkill: { did: 'Killed a process', does: 'kills a process' },
  killall: { did: 'Killed a process', does: 'kills a process' },
};

/** A grave stage, or null when this link is ordinary. */
function graveStage(head: string, argv: string[]): Stage | null {
  // `kill -0` sends no signal at all — it asks whether a process is still
  // there, and 41 of his commands use it to wait for one. It is not a kill.
  if ((head === 'kill' || head === 'pkill') && has(argv, '-0')) return null;
  const heavy = GRAVE[head];
  if (heavy) {
    const target = object(argv, 1);
    return {
      text: target ? `${heavy.verb} ${brief(place(target))}` : heavy.alone,
      kind: 'grave',
      grave: true,
    };
  }
  if (head === 'git') {
    const { sub, at } = gitCommand(argv);
    const git = ordinaryGitArgs(argv, at);
    if (sub === 'push' && has(git, '--force', '-f', '--force-with-lease')) {
      return { text: 'Force-pushed', kind: 'grave', grave: true };
    }
    if (sub === 'rm') return { text: `Deleted ${brief(place(object(git, 2))) || 'a tracked file'}`, kind: 'grave', grave: true };
    if (sub === 'clean' && !has(git, '-n', '--dry-run')) return { text: 'Threw away untracked files', kind: 'grave', grave: true };
    if (sub === 'reset' && has(git, '--hard')) return { text: 'Threw away every change', kind: 'grave', grave: true };
    if (sub === 'branch' && has(git, '-d', '-D', '--delete')) return { text: 'Deleted a branch', kind: 'grave', grave: true };
    if (sub === 'tag' && has(git, '-d', '--delete')) return { text: 'Deleted a tag', kind: 'grave', grave: true };
    if (sub === 'worktree' && git[2] === 'remove') return { text: 'Removed a worktree', kind: 'grave', grave: true };
  }
  if (head === 'docker') {
    const sub = argv[1] ?? '';
    if (sub === 'rm' || sub === 'rmi') return { text: 'Removed a container', kind: 'grave', grave: true };
    if (sub === 'system' && argv[2] === 'prune') return { text: 'Pruned Docker', kind: 'grave', grave: true };
  }
  if (head === 'kubectl' && argv[1] === 'delete') {
    return { text: `Deleted ${objects(argv, 2).slice(0, 2).join(' ') || 'a resource'}`, kind: 'grave', grave: true };
  }
  // `find … -delete` deletes every match and holds none of the four words the
  // backstop scans for, so nothing else in this file can see it. Read before
  // the search rule, which would otherwise call it looking around.
  if (head === 'find' && has(argv, '-delete')) {
    const nameAt = argv.indexOf('-name');
    const pattern = nameAt >= 0 ? argv[nameAt + 1] : '';
    return {
      text: pattern ? `Deleted every ${brief(pattern, 32)}` : 'Deleted what it found',
      kind: 'grave',
      grave: true,
    };
  }
  return null;
}

/**
 * A delete carried by a flag rather than by a verb: `find … -delete`, and
 * `rsync --delete`, which empties whatever the source does not have.
 *
 * Neither holds any of the four words below. The chain reader catches a plain
 * `find … -delete` by its head, but a `find` on the first line of a five-line
 * script never reaches it, and that is exactly the shape the replay found in
 * his own record: `find data/leaves -type d -empty -delete` opening a script,
 * said as "Ran a shell script (3 lines)" and nothing more (bw-7ks.24.7).
 *
 * `-delete-branch` and `--delete-label` are flags that hold the word and throw
 * no work away, so the tail is refused.
 */
const A_DELETE_FLAG = /\s--?delete(?![\w-])/;

/**
 * What a command deletes or kills, wherever the verb is buried.
 *
 * The substrings are read first because they are a native scan and the two
 * patterns behind them are not: nine commands in ten hold none of them and
 * never pay for a pattern at all. `rmdir` carries `rm`, and `pkill` and
 * `killall` carry `kill`, so four reads cover all seven verbs, and a fifth
 * covers the flag.
 */
function graveBackstop(command: string): { did: string; does: string } | null {
  const executable = commandText(command);
  if (executable.indexOf('delete') >= 0 && A_DELETE_FLAG.test(executable)) {
    return { did: 'Deleted files', does: 'deletes files' };
  }
  if (
    executable.indexOf('rm') < 0 &&
    executable.indexOf('kill') < 0 &&
    executable.indexOf('shred') < 0 &&
    executable.indexOf('mkfs') < 0
  ) {
    return null;
  }
  const found = GRAVE_ANYWHERE.exec(executable);
  return found ? (GRAVE_BACKSTOP[found[1]!] ?? { did: 'Deleted files', does: 'deletes files' }) : null;
}

/** Shell syntax without quoted argument prose. Commands handed to a shell and
 * command substitutions remain executable and are appended back. */
function commandText(command: string): string {
  const nested: string[] = [];
  for (const match of command.matchAll(/\b(?:sh|bash|zsh|dash)\s+(?:-\w+\s+)*-\w*c\w*\s+(['"])([\s\S]*?)\1/g)) {
    if (match[2]) nested.push(match[2]);
  }
  for (const match of command.matchAll(/\$\(([^)]*)\)/g)) if (match[1]) nested.push(match[1]);
  return `${command.replace(/'[^']*'|"[^"]*"/g, ' ')}\n${nested.join('\n')}`;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

interface Rule {
  kind: RanKind;
  /** The sentence for this link, or null to leave the link unnamed. */
  say: (argv: string[]) => string | null;
}

/** `bd close bw-7dqe.1` reads as "Closed bw-7dqe.1", and so on down the tool. */
const BD: Record<string, (argv: string[]) => string> = {
  close: (a) => `Closed ${object(a, 2) || 'a card'}`,
  show: (a) => `Showed ${object(a, 2) || 'a card'}`,
  ready: () => 'Listed the work that is ready',
  list: () => 'Listed the board',
  blocked: () => 'Listed what is blocked',
  prime: () => 'Read the board rules',
  reclaim: () => 'Took work back',
  remember: () => 'Wrote a note to the board',
  stats: () => 'Counted the board',
  create: () => 'Created a card',
  search: () => 'Searched the board',
  label: (a) => `${a[2] === 'remove' ? 'Removed' : 'Labeled'} ${object(a, 3) || object(a, 2) || 'a card'}`,
  supersede: (a) => `Superseded ${object(a, 2) || 'a card'}`,
  children: () => 'Listed the child cards',
  doctor: () => 'Checked the board health',
  unclaim: (a) => `Released ${object(a, 2) || 'a card'}`,
  note: (a) => `Wrote a note on ${object(a, 2) || 'a card'}`,
  'set-state': (a) => `Set the state of ${object(a, 2) || 'a card'}`,
};

function bdSaid(argv: string[]): string {
  const sub = argv[1] ?? '';
  if (sub === 'update') {
    const card = object(argv, 2) || 'a card';
    if (has(argv, '--claim')) return `Claimed ${card}`;
    if (argv.some((w) => w.indexOf('--append-notes') === 0)) return `Wrote a note on ${card}`;
    if (argv.some((w) => w.indexOf('--status') === 0)) return `Moved ${card}`;
    return `Updated ${card}`;
  }
  if (sub === 'comments') {
    const how = argv[2] ?? '';
    const card = object(argv, 3) || 'a card';
    if (how === 'add') return `Commented on ${card}`;
    return `Read the comments on ${card}`;
  }
  if (sub === 'dep') {
    const pair = objects(argv, 3);
    return pair.length >= 2 ? `Linked ${pair[0]} and ${pair[1]}` : 'Linked two cards';
  }
  if (sub === 'merge-slot') {
    const how = argv[2] ?? '';
    if (how === 'acquire') return 'Took the merge slot';
    if (how === 'release') return 'Gave the merge slot back';
    return 'Checked the merge slot';
  }
  if (sub === 'dolt') {
    const how = argv[2] ?? '';
    if (how === 'start') return 'Started the board database';
    if (how === 'stop') return 'Stopped the board database';
    if (how === 'status' || how === 'show' || how === 'test') return 'Checked the board database';
    if (how === 'commit') return 'Committed the board database';
    if (how === 'push') return 'Pushed the board database';
    if (how === 'pull') return 'Pulled the board database';
    return how ? `Ran bd dolt ${brief(how)}` : 'Ran the board database tool';
  }
  const known = BD[sub];
  if (known) return known(argv);
  return sub ? `Asked the board to ${sub}` : 'Asked the board';
}

const GIT: Record<string, (argv: string[]) => string> = {
  status: () => 'Checked the working tree',
  log: () => 'Read the history',
  show: (a) => `Showed ${brief(object(a, 2)) || 'a commit'}`,
  diff: (a) => {
    const what = objects(a, 2).filter((w) => w.indexOf('..') < 0);
    return what.length ? `Diffed ${brief(place(what[what.length - 1]!))}` : 'Diffed the changes';
  },
  add: (a) => {
    const what = objects(a, 2).filter(worthNaming);
    if (!what.length) return 'Staged everything';
    return what.length > 1 ? `Staged ${what.length} paths` : `Staged ${brief(place(what[0]!))}`;
  },
  commit: () => 'Committed',
  push: () => 'Pushed',
  pull: () => 'Pulled',
  fetch: () => 'Fetched',
  checkout: (a) => `Checked out ${brief(object(a, 2)) || 'a branch'}`,
  switch: (a) => `Switched to ${brief(object(a, 2)) || 'a branch'}`,
  branch: (a) => (has(a, '-b', '-c') ? 'Made a branch' : 'Listed the branches'),
  merge: (a) => has(a, '--abort') ? 'Aborted the merge' : has(a, '--continue') ? 'Continued the merge' : `Merged ${brief(object(a, 2)) || 'a branch'}`,
  rebase: (a) => has(a, '--abort') ? 'Aborted the rebase' : has(a, '--continue') ? 'Continued the rebase' : has(a, '--skip') ? 'Skipped a rebase commit' : `Rebased onto ${brief(object(a, 2)) || 'main'}`,
  stash: (a) => (a[2] === 'pop' || a[2] === 'apply' ? 'Took the stash back' : 'Stashed the changes'),
  reset: () => 'Unstaged the changes',
  restore: (a) => `Restored ${brief(place(object(a, 2))) || 'a file'}`,
  grep: (a) => `Searched the history for ${brief(object(a, 2))}`,
  'rev-parse': () => 'Resolved a revision',
  'merge-base': () => 'Found the common ancestor',
  'ls-files': () => 'Listed the tracked files',
  'show-ref': (a) => has(a, '--verify', '--exists') ? 'Checked a reference' : 'Listed the references',
  'for-each-ref': () => 'Listed the references',
  'check-ignore': () => 'Checked ignored paths',
  'write-tree': () => 'Wrote the index tree',
  blame: (a) => `Blamed ${brief(place(object(a, 2))) || 'a file'}`,
  tag: (a) => object(a, 2) ? 'Tagged' : 'Listed the tags',
  remote: (a) => {
    if (a[2] === 'add') return `Added remote ${brief(object(a, 3)) || ''}`.trim();
    if (a[2] === 'remove' || a[2] === 'rm') return `Removed remote ${brief(object(a, 3)) || ''}`.trim();
    if (a[2] === 'set-url') return `Changed remote ${brief(object(a, 3)) || ''}`.trim();
    return 'Listed the remotes';
  },
  clone: (a) => `Cloned ${address(object(a, 2)) || 'a repository'}`,
  init: () => 'Started a repository',
  apply: (a) => has(a, '--check') ? 'Checked whether a patch applies' : 'Applied a patch',
  am: () => 'Applied a patch',
  cherry: () => 'Compared the branches',
  'cherry-pick': (a) => has(a, '--abort') ? 'Aborted the cherry-pick' : has(a, '--continue') ? 'Continued the cherry-pick' : `Cherry-picked ${brief(object(a, 2))}`,
  describe: () => 'Named the current commit',
  shortlog: () => 'Read the history',
  worktree: (a) => {
    const how = a[2] ?? '';
    if (how === 'add') return `Cut a worktree${object(a, 3) ? ` at ${leaf(object(a, 3))}` : ''}`;
    if (how === 'remove') return 'Removed a worktree';
    if (how === 'prune') return 'Pruned the worktrees';
    return 'Listed the worktrees';
  },
};

/**
 * Git accepts repository-wide options before its subcommand. Agents use `-C`
 * constantly to avoid a separate `cd`, so treating argv[1] as the operation
 * turns an ordinary status/read/commit into the useless label "Ran git -C".
 */
function gitCommand(argv: string[]): { sub: string; at: number } {
  let at = 1;
  while (at < argv.length) {
    const word = argv[at] ?? '';
    if (word === '-C' || word === '-c' || word === '--git-dir' || word === '--work-tree' || word === '--namespace') {
      at += 2;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace)=/.test(word)) {
      at += 1;
      continue;
    }
    break;
  }
  return { sub: argv[at] ?? '', at };
}

/** Put a globally-optioned Git invocation into the shape the sentence table expects. */
function ordinaryGitArgs(argv: string[], at: number): string[] {
  return at === 1 ? argv : ['git', ...argv.slice(at)];
}

const CARGO: Record<string, string> = {
  build: 'Built the Rust side',
  test: 'Ran the Rust tests',
  run: 'Ran the Rust binary',
  check: 'Checked the Rust side',
  clippy: 'Linted the Rust side',
  fmt: 'Formatted the Rust side',
  bench: 'Benchmarked the Rust side',
  doc: 'Built the Rust docs',
  add: 'Added a Rust dependency',
  update: 'Updated the Rust dependencies',
  tree: 'Read the Rust dependency tree',
};

/** Which kind a Rust subcommand belongs to. */
const CARGO_KIND: Record<string, RanKind> = {
  build: 'build',
  test: 'test',
  run: 'run',
  check: 'build',
  clippy: 'lint',
  fmt: 'lint',
  bench: 'test',
  doc: 'build',
};

/** Which kind a Go subcommand belongs to. */
const GO_KIND: Record<string, RanKind> = { test: 'test', run: 'run', vet: 'lint', fmt: 'lint' };

/** The tools `npx`, `npm run` and a bare invocation all reach for. */
const TOOLS: Record<string, { kind: RanKind; said: string }> = {
  vitest: { kind: 'test', said: 'Ran the tests' },
  jest: { kind: 'test', said: 'Ran the tests' },
  playwright: { kind: 'test', said: 'Ran the browser tests' },
  cypress: { kind: 'test', said: 'Ran the browser tests' },
  pytest: { kind: 'test', said: 'Ran the Python tests' },
  tsc: { kind: 'build', said: 'Typechecked' },
  eslint: { kind: 'lint', said: 'Linted' },
  prettier: { kind: 'lint', said: 'Formatted' },
  ruff: { kind: 'lint', said: 'Linted the Python side' },
  mypy: { kind: 'build', said: 'Typechecked the Python side' },
  black: { kind: 'lint', said: 'Formatted the Python side' },
  next: { kind: 'build', said: 'Built the app' },
  webpack: { kind: 'build', said: 'Built the app' },
  vite: { kind: 'build', said: 'Built the app' },
  esbuild: { kind: 'build', said: 'Built the app' },
};

/** What `npm run <name>` means, where the name says it plainly enough. */
const SCRIPTS: Record<string, { kind: RanKind; said: string }> = {
  build: { kind: 'build', said: 'Built the app' },
  dev: { kind: 'run', said: 'Started the app' },
  start: { kind: 'run', said: 'Started the app' },
  test: { kind: 'test', said: 'Ran the tests' },
  lint: { kind: 'lint', said: 'Linted' },
  'lint:fix': { kind: 'lint', said: 'Linted and fixed' },
  typecheck: { kind: 'build', said: 'Typechecked' },
  workbench: { kind: 'run', said: 'Started the workbench' },
};

function nodePackage(argv: string[]): { kind: RanKind; said: string } {
  const head = named(argv[0] ?? '');
  const sub = argv[1] ?? '';
  if (sub === 'install' || sub === 'i' || sub === 'ci' || sub === 'add') {
    return { kind: 'build', said: 'Installed the dependencies' };
  }
  if (sub === 'test') return { kind: 'test', said: 'Ran the tests' };
  if (sub === 'run' || sub === 'run-script') {
    const name = object(argv, 2);
    const known = SCRIPTS[name];
    if (known) return known;
    return { kind: 'run', said: name ? `Ran the ${name} step` : 'Ran a step' };
  }
  // `npx <tool>` and `yarn <tool>` both put the tool where the subcommand goes.
  const front = named(sub);
  if (front === 'next' || front === 'vite' || front === 'nuxt' || front === 'astro') {
    return startsOrBuilds(object(argv, 2));
  }
  const tool = TOOLS[front];
  if (tool) {
    if (front === 'prettier' && has(argv, '--check')) return { kind: 'lint', said: 'Checked formatting' };
    if (front === 'prettier' && has(argv, '--write', '-w')) return { kind: 'edit', said: 'Formatted files' };
    if (front === 'eslint' && has(argv, '--fix')) return { kind: 'edit', said: 'Linted and fixed files' };
    if (front === 'ruff' && argv.includes('format') && has(argv, '--check')) return { kind: 'lint', said: 'Checked Python formatting' };
    if (front === 'black' && has(argv, '--check')) return { kind: 'lint', said: 'Checked Python formatting' };
    return tool;
  }
  const script = SCRIPTS[sub];
  if (script) return script;
  if (!sub) return { kind: 'run', said: `Ran ${head}` };
  return { kind: 'run', said: `Ran ${brief(named(sub))}` };
}

/** `next dev` starts the app and `next build` builds it — one word apart. */
function startsOrBuilds(how: string): { kind: RanKind; said: string } {
  if (how === 'dev' || how === 'start' || how === 'preview' || how === 'serve') {
    return { kind: 'run', said: 'Started the app' };
  }
  return { kind: 'build', said: 'Built the app' };
}

/** A URL as a reader reads it: the host, and the path if there is one. */
function address(url: string): string {
  const m = /^[a-z]+:\/\/([^/\s]+)(\/[^\s?#]*)?/i.exec(url);
  if (!m) return brief(url);
  const host = m[1]!;
  const path = m[2] ?? '';
  return brief(path && path !== '/' ? `${host}${path}` : host);
}

/**
 * Every head this can name, and the sentence it gives. A head that is not here
 * leaves its link unnamed; a command whose every link is unnamed comes back
 * null and draws as itself.
 */
const HEADS: Record<string, Rule> = {
  // The board and its own tools.
  bd: { kind: 'board', say: bdSaid },
  job: {
    kind: 'board',
    say: (a) => {
      const sub = a[1] ?? '';
      if (sub === 'new') return 'Opened a job';
      if (sub === 'under') return 'Added the work items';
      if (sub === 'epic') return 'Opened a container';
      if (sub === 'cancel') return 'Dropped a card';
      if (sub === 'upgrade') return 'Filled in a placeholder';
      return sub ? `Ran job ${brief(sub)}` : 'Ran the job tool';
    },
  },
  land: { kind: 'board', say: (a) => `Landed ${object(a, 1) || 'the change'}` },
  review: { kind: 'board', say: (a) => `Reviewed ${object(a, 1) || 'a card'}` },
  report: {
    kind: 'board',
    say: (a) => {
      const sub = a[1] ?? '';
      if (sub === 'new') return 'Started a report';
      if (sub === 'list') return 'Listed the reports';
      return `Read the ${brief(sub)} report`;
    },
  },
  checks: {
    kind: 'test',
    say: (a) => has(a, '--help') ? 'Read the project check options' : 'Ran the project checks',
  },

  // Coding-agent CLIs. These are ordinary commands whichever provider issued
  // them; keeping them here gives Claude and Codex the same sentence.
  codex: {
    kind: 'run',
    say: (a) => {
      if (has(a, '--version')) return 'Checked the Codex version';
      if (a[1] !== 'app-server') return `Ran Codex ${brief(a[1] ?? '')}`.trim();
      if (a.includes('generate-json-schema')) return 'Generated the Codex protocol schema';
      if (a.includes('generate-ts')) return 'Generated the Codex protocol types';
      if (has(a, '--help')) return 'Read the Codex app-server options';
      if (has(a, '--stdio')) return 'Started the Codex app server';
      return 'Ran the Codex app server';
    },
  },

  // Version control.
  git: {
    kind: 'vcs',
    say: (a) => {
      const { sub, at } = gitCommand(a);
      const known = GIT[sub];
      if (known) return known(ordinaryGitArgs(a, at));
      return sub ? `Ran git ${sub}` : null;
    },
  },
  gh: {
    kind: 'net',
    say: (a) => {
      const sub = a[1] ?? '';
      const how = a[2] ?? '';
      if (sub === 'pr') {
        if (how === 'create') return 'Opened a pull request';
        if (how === 'view') return 'Read a pull request';
        if (how === 'list') return 'Listed the pull requests';
        if (how === 'merge') return 'Merged a pull request';
        return 'Worked on a pull request';
      }
      if (sub === 'issue') return 'Worked on an issue';
      if (sub === 'run') return 'Checked a workflow run';
      if (sub === 'api') return 'Asked the GitHub API';
      return sub ? `Asked GitHub for ${sub}` : 'Asked GitHub';
    },
  },

  // Building, testing, linting.
  cargo: {
    kind: 'build',
    say: (a) => {
      const sub = a[1] ?? '';
      return CARGO[sub] ?? (sub ? `Ran cargo ${sub}` : null);
    },
  },
  make: { kind: 'build', say: (a) => (object(a, 1) ? `Built ${object(a, 1)}` : 'Built') },
  cmake: { kind: 'build', say: () => 'Configured the build' },
  gcc: { kind: 'build', say: () => 'Compiled' },
  'g++': { kind: 'build', say: () => 'Compiled' },
  clang: { kind: 'build', say: () => 'Compiled' },
  rustc: { kind: 'build', say: () => 'Compiled' },
  gradle: { kind: 'build', say: () => 'Built with Gradle' },
  mvn: { kind: 'build', say: () => 'Built with Maven' },
  go: {
    kind: 'build',
    say: (a) => {
      const sub = a[1] ?? '';
      if (sub === 'test') return 'Ran the Go tests';
      if (sub === 'build') return 'Built the Go side';
      if (sub === 'run') return 'Ran the Go binary';
      if (sub === 'vet') return 'Vetted the Go side';
      return sub ? `Ran go ${sub}` : null;
    },
  },
  pytest: { kind: 'test', say: () => 'Ran the Python tests' },

  // Reading.
  cat: {
    kind: 'read',
    say: (a) => {
      const what = objects(a, 1);
      if (!what.length) return null;
      return what.length > 1 ? `Read ${what.length} files` : `Read ${brief(place(what[0]!))}`;
    },
  },
  head: { kind: 'read', say: (a) => (object(a, 1) ? `Read the top of ${brief(place(object(a, 1)))}` : null) },
  tail: {
    kind: 'read',
    say: (a) => {
      const target = objects(a, 1).filter((word) => !/^\+?\d+$/.test(word)).at(-1) ?? '';
      return target ? `Read the end of ${brief(place(target))}` : 'Read the end of the output';
    },
  },
  ls: { kind: 'read', say: (a) => `Listed ${worthNaming(object(a, 1)) ? brief(place(object(a, 1))) : 'this folder'}` },
  wc: { kind: 'read', say: (a) => (object(a, 1) ? `Counted ${brief(place(object(a, 1)))}` : 'Counted the lines') },
  stat: { kind: 'read', say: (a) => `Checked ${brief(place(object(a, 1))) || 'a file'}` },
  du: { kind: 'read', say: () => 'Measured what is on disk' },
  df: { kind: 'system', say: () => 'Checked the free space' },
  strings: { kind: 'read', say: (a) => `Read the text out of ${brief(place(object(a, 1))) || 'a file'}` },
  readlink: { kind: 'read', say: (a) => `Resolved ${brief(place(object(a, 1))) || 'a path'}` },
  realpath: { kind: 'read', say: (a) => `Resolved ${brief(place(object(a, 1))) || 'a path'}` },
  diff: {
    kind: 'read',
    say: (a) => {
      const what = objects(a, 1);
      return what.length >= 2 ? `Compared ${brief(leaf(what[0]!))} and ${brief(leaf(what[1]!))}` : 'Compared two files';
    },
  },
  cmp: {
    kind: 'read',
    say: (a) => {
      const what = objects(a, 1);
      return what.length >= 2 ? `Compared ${brief(leaf(what[0]!))} and ${brief(leaf(what[1]!))}` : 'Compared two files';
    },
  },
  join: { kind: 'read', say: () => 'Joined matching lines from files' },
  nl: { kind: 'read', say: (a) => `Read numbered ${brief(place(object(a, 1))) || 'text'}` },

  // Searching.
  grep: { kind: 'search', say: (a) => searchSaid(a, 1) },
  rg: {
    kind: 'search',
    say: (a) => {
      if (has(a, '--files')) {
        const globs: string[] = [];
        for (let i = 1; i < a.length; i++) {
          if ((a[i] === '-g' || a[i] === '--glob') && a[i + 1]) globs.push(a[++i]!);
        }
        return globs.length ? `Listed the files matching ${brief(globs.join(', '), 32)}` : 'Listed the files';
      }
      return searchSaid(a, 1);
    },
  },
  ag: { kind: 'search', say: (a) => searchSaid(a, 1) },
  ack: { kind: 'search', say: (a) => searchSaid(a, 1) },
  find: {
    kind: 'search',
    say: (a) => {
      const nameAt = a.indexOf('-name');
      const pattern = nameAt >= 0 ? a[nameAt + 1] : '';
      const where = object(a, 1);
      const inside = worthNaming(where) ? ` in ${brief(place(where), 28)}` : '';
      if (pattern) return `Looked for ${brief(pattern, 32)}${inside}`;
      return `Looked through ${worthNaming(where) ? brief(place(where), 28) : 'the tree'}`;
    },
  },
  which: { kind: 'system', say: (a) => `Looked for ${brief(object(a, 1)) || 'a program'}` },
  whereis: { kind: 'system', say: (a) => `Looked for ${brief(object(a, 1)) || 'a program'}` },

  // Changing things on disk.
  sed: {
    kind: 'edit',
    say: (a) => {
      const target = objects(a, 1).slice(1)[0] ?? '';
      if (has(a, '-i')) return `Rewrote ${brief(place(target)) || 'a file'}`;
      // `sed -n '120,180p' file` is how a range of a file gets read.
      if (has(a, '-n') && target) return `Read part of ${brief(place(target))}`;
      return target ? `Picked lines out of ${brief(place(target))}` : null;
    },
  },
  awk: { kind: 'data', say: (a) => (objects(a, 1).length > 1 ? 'Picked fields out of a file' : null) },
  mkdir: { kind: 'edit', say: (a) => `Made ${brief(place(object(a, 1))) || 'a folder'}` },
  touch: { kind: 'edit', say: (a) => `Made ${brief(place(object(a, 1))) || 'a file'}` },
  cp: {
    kind: 'edit',
    say: (a) => {
      const what = objects(a, 1);
      return what.length >= 2 ? `Copied ${brief(leaf(what[0]!))} to ${brief(place(what[what.length - 1]!))}` : 'Copied a file';
    },
  },
  mv: {
    kind: 'edit',
    say: (a) => {
      const what = objects(a, 1);
      return what.length >= 2 ? `Moved ${brief(leaf(what[0]!))} to ${brief(place(what[what.length - 1]!))}` : 'Moved a file';
    },
  },
  ln: { kind: 'edit', say: (a) => `Linked ${brief(place(objects(a, 1)[objects(a, 1).length - 1] ?? '')) || 'a path'}` },
  chmod: { kind: 'edit', say: (a) => `Changed the permissions on ${brief(place(objects(a, 1)[1] ?? '')) || 'a path'}` },
  chown: { kind: 'edit', say: (a) => `Changed the owner of ${brief(place(objects(a, 1)[1] ?? '')) || 'a path'}` },
  tar: { kind: 'edit', say: (a) => (has(a, '-x') ? 'Unpacked an archive' : 'Packed an archive') },
  zip: { kind: 'edit', say: () => 'Packed an archive' },
  unzip: { kind: 'edit', say: () => 'Unpacked an archive' },
  gzip: { kind: 'edit', say: () => 'Compressed a file' },
  patch: { kind: 'edit', say: () => 'Applied a patch' },

  // Running things.
  node: { kind: 'run', say: (a) => runSaid(a, 'Node') },
  tsx: { kind: 'run', say: (a) => runSaid(a, 'TypeScript') },
  deno: { kind: 'run', say: (a) => runSaid(a, 'Deno') },
  bun: { kind: 'run', say: (a) => runSaid(a, 'Bun') },
  python: { kind: 'run', say: (a) => runSaid(a, 'Python') },
  python3: { kind: 'run', say: (a) => runSaid(a, 'Python') },
  bash: { kind: 'run', say: (a) => runSaid(a, 'shell') },
  sh: { kind: 'run', say: (a) => runSaid(a, 'shell') },
  zsh: { kind: 'run', say: (a) => runSaid(a, 'shell') },
  npm: { kind: 'run', say: () => null },
  pnpm: { kind: 'run', say: () => null },
  yarn: { kind: 'run', say: () => null },
  npx: { kind: 'run', say: () => null },
  next: { kind: 'build', say: (a) => startsOrBuilds(object(a, 1)).said },
  vite: { kind: 'build', say: (a) => startsOrBuilds(object(a, 1)).said },
  pip: { kind: 'build', say: () => 'Installed the Python dependencies' },
  pip3: { kind: 'build', say: () => 'Installed the Python dependencies' },
  uv: { kind: 'build', say: () => 'Installed the Python dependencies' },
  poetry: { kind: 'build', say: () => 'Installed the Python dependencies' },

  // The network.
  curl: { kind: 'net', say: (a) => `Fetched ${address(object(a, 1)) || 'a page'}` },
  wget: { kind: 'net', say: (a) => `Downloaded ${address(object(a, 1)) || 'a page'}` },
  ssh: { kind: 'net', say: (a) => `Ran a command on ${brief(object(a, 1)) || 'another machine'}` },
  scp: { kind: 'net', say: () => 'Copied files to another machine' },
  rsync: { kind: 'net', say: () => 'Copied files across' },

  // The machine.
  ps: { kind: 'system', say: () => 'Listed what is running' },
  pgrep: { kind: 'system', say: (a) => `Looked for ${brief(object(a, 1)) || 'a running program'}` },
  ss: { kind: 'system', say: () => 'Checked what is listening' },
  lsof: { kind: 'system', say: () => 'Checked what is listening' },
  netstat: { kind: 'system', say: () => 'Checked what is listening' },
  systemctl: {
    kind: 'system',
    say: (a) => {
      const rest = objects(a, 1);
      const how = rest[0] ?? '';
      const service = brief(rest[1] ?? '') || 'a service';
      if (how === 'status') return `Checked ${service}`;
      if (how === 'is-active' || how === 'is-failed' || how === 'is-enabled' || how === 'is-system-running') return `Checked ${service}`;
      if (how === 'show') return `Showed ${service}`;
      if (how === 'cat') return `Read ${service}`;
      const did = SYSTEMD[how];
      if (did) return `${did} ${service}`;
      return `Asked systemd for ${how || 'a service'}`;
    },
  },
  docker: {
    kind: 'system',
    say: (a) => {
      const sub = a[1] ?? '';
      if (sub === 'ps') return 'Listed the containers';
      if (sub === 'logs') return 'Read a container log';
      if (sub === 'exec') return 'Ran a command in a container';
      if (sub === 'build') return 'Built an image';
      if (sub === 'images') return 'Listed the images';
      if (sub === 'compose') {
        const how = a[2] ?? '';
        if (how === 'up') return 'Started the containers';
        if (how === 'down') return 'Stopped the containers';
        if (how === 'logs') return 'Read the container logs';
        if (how === 'exec') return 'Ran a command in a container';
        if (how === 'ps') return 'Listed the containers';
        if (how === 'build') return 'Built the containers';
        if (how === 'pull') return 'Pulled the container images';
        if (how === 'restart') return 'Restarted the containers';
        if (how === 'start') return 'Started the containers';
        if (how === 'stop') return 'Stopped the containers';
        return 'Worked on the containers';
      }
      if (sub === 'run') return 'Started a container';
      return sub ? `Asked Docker to ${sub}` : 'Asked Docker';
    },
  },
  kubectl: {
    kind: 'system',
    say: (a) => {
      const sub = a[1] ?? '';
      if (sub === 'get') return `Listed ${object(a, 2) || 'resources'}`;
      if (sub === 'logs') return 'Read a pod log';
      if (sub === 'exec') return 'Ran a command in a pod';
      if (sub === 'describe') return `Described ${object(a, 2) || 'a resource'}`;
      if (sub === 'apply') return 'Applied a manifest';
      return sub ? `Asked the cluster to ${sub}` : 'Asked the cluster';
    },
  },
  date: { kind: 'system', say: () => 'Checked the time' },
  magick: { kind: 'edit', say: () => 'Worked on a picture' },
  ffmpeg: { kind: 'edit', say: () => 'Worked on a video' },

  // Data.
  sqlite3: { kind: 'data', say: (a) => `Queried ${brief(leaf(object(a, 1))) || 'the database'}` },
  psql: { kind: 'data', say: () => 'Queried the database' },
  mysql: { kind: 'data', say: () => 'Queried the database' },
  jq: { kind: 'data', say: () => 'Picked fields out of some JSON' },

  // Waiting.
  sleep: { kind: 'wait', say: (a) => (object(a, 1) ? `Waited ${object(a, 1)}s` : 'Waited') },
  // Only `kill -0` reaches here; a real kill was taken as grave well before.
  kill: { kind: 'wait', say: () => 'Checked whether a process is still running' },
};

/** Past tense for the four things anyone does to a service. Spelled out,
 * because building it by adding "ed" gives "Stoped". */
const SYSTEMD: Record<string, string> = {
  start: 'Started',
  stop: 'Stopped',
  restart: 'Restarted',
  reload: 'Reloaded',
  enable: 'Enabled',
  disable: 'Disabled',
};

/** `grep -rn "pattern" path` — the pattern first, then where it looked. */
function searchSaid(argv: string[], from: number): string | null {
  const rest = objects(argv, from);
  const pattern = rest[0];
  if (!pattern) return null;
  const where = rest.slice(1).filter(worthNaming);
  const inside =
    where.length === 0 ? '' : where.length > 1 ? ` across ${where.length} paths` : ` in ${brief(place(where[0]!), 28)}`;
  return `Searched for ${brief(pattern, 32)}${inside}`;
}

/** `node x.mjs`, `python3 -c "…"` — what a runner was pointed at. */
function runSaid(argv: string[], tongue: string): string | null {
  const inlineAt = argv.findIndex((word) => word === '-c' || word === '-e' || word === '--eval');
  if (inlineAt >= 0) {
    const code = argv[inlineAt + 1];
    // `one-liner` says how the program was passed, not what ran. Keep enough
    // of the actual program to make the row useful while still bounding
    // generated scripts and avoiding the runner's flags.
    return code ? `Ran ${tongue}: ${brief(code, 52)}` : `Ran a ${tongue} script`;
  }
  const script = object(argv, 1);
  if (!script || script === '-') return `Ran a ${tongue} script`;
  const file = leaf(script);
  if (/codex-ownership-smoke\.mjs$/.test(file)) return 'Checked Codex ownership in the browser';
  if (/chat-(?:open-cost|opens-fast|typing-cost)\.mjs$/.test(file)) return 'Measured chat performance in the browser';
  if (/\.mjs$/.test(file) && /(?:smoke|browser|chat)/.test(file)) return `Ran the ${brief(file.replace(/\.mjs$/, '').replaceAll('-', ' '))} browser check`;
  return `Ran ${brief(file)}`;
}

// ---------------------------------------------------------------------------
// Scripts, loops and here-documents
// ---------------------------------------------------------------------------

/** A here-document, a loop or a branch is a script, not a chain. */
const IS_SCRIPT = /<<[-\s]*['"]?\w|^\s*(?:for|while|until|if|function)\s|;\s*(?:do|then)\s|\n\s*(?:do|then)\s/;

/** Shell operators and control words, with quoted argument data blanked out.
 * A multiline commit message is still one argument, not a nineteen-line shell
 * script; testing the raw text made prose containing `then` look executable. */
function shellSyntax(command: string): string {
  let quote = '';
  let syntax = '';
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at]!;
    if (quote) {
      if (char === '\\' && quote === '"' && at + 1 < command.length) at += 1;
      else if (char === quote) quote = '';
      syntax += ' ';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      syntax += ' ';
      continue;
    }
    if (char === '\\' && at + 1 < command.length) {
      syntax += '  ';
      at += 1;
      continue;
    }
    syntax += char;
  }
  return syntax;
}

/** `cat > path <<'EOF'` and `tee path <<EOF` are how a file gets written. */
const WRITES_A_FILE = /(?:^|\|)\s*(?:cat|tee)\s+(?:-a\s+)?>?>?\s*([^\s<>|;&]+)[^|;&]*<</;

/** What a script is written in, from the word that runs it. */
const TONGUE: Record<string, string> = {
  python: 'Python',
  python3: 'Python',
  node: 'Node',
  deno: 'Deno',
  bun: 'Bun',
  bash: 'shell',
  sh: 'shell',
  zsh: 'shell',
  sqlite3: 'SQL',
  psql: 'SQL',
  mysql: 'SQL',
};

function scriptStage(command: string): Stage | null {
  const written = WRITES_A_FILE.exec(command);
  if (written && written[1]) {
    return { text: `Wrote ${brief(place(written[1]))}`, kind: 'edit', grave: false };
  }
  const lines = command.split('\n').length;
  let tongue = '';
  let read = 0;
  for (const link of links(command)) {
    // Only the opening links can name the language. Past that it is the body
    // of the script, and reading it is work with nothing at the end of it.
    if (read++ > 6) break;
    const argv = words(link);
    if (!argv.length) continue;
    const head = named(argv[0]!);
    if (TONGUE[head]) {
      tongue = TONGUE[head]!;
      break;
    }
  }
  const grave = graveBackstop(command);
  const size = lines > 1 ? ` (${lines} lines)` : '';
  const what = `Ran a ${tongue || 'shell'} script${size}`;
  if (grave) return { text: `${what} that ${grave.does}`, kind: 'grave', grave: true };
  return { text: what, kind: 'script', grave: false };
}

// ---------------------------------------------------------------------------
// Reading one command
// ---------------------------------------------------------------------------

/** The head of a link, with every wrapper taken off. */
function headOf(argv: string[]): string[] {
  let rest = argv;
  for (let i = 0; i < 4 && rest.length; i++) {
    const head = named(rest[0]!);
    const skips = PASSES_THROUGH[head];
    if (skips === undefined) return rest;
    if (head === 'rtk' && RTK_OWN.indexOf(rest[1] ?? '') >= 0) return rest;
    // `rtk proxy git status` and `rtk git status` both mean the git.
    let from = 1 + skips;
    if (head === 'rtk' && rest[1] === 'proxy') from = 2;
    rest = rest.slice(from);
    while (rest.length && rest[0]!.charAt(0) === '-') rest = rest.slice(1);
  }
  return rest;
}

const SHORT_HELP = new Set([
  'bd', 'cargo', 'codex', 'docker', 'gh', 'git', 'go', 'job', 'kubectl', 'land',
  'make', 'npm', 'npx', 'pnpm', 'report', 'review', 'yarn',
]);

const COMMAND_NAME: Record<string, string> = {
  bd: 'board',
  gh: 'GitHub',
  git: 'Git',
};

const commandName = (head: string): string => COMMAND_NAME[head] ?? head
  .replace(/\.(?:py|mjs|cjs|js|ts|tsx|sh)$/, '')
  .replaceAll('-', ' ');

/** Options whose following word is data even when that data begins with `-`.
 * Without this distinction, a commit message or board reason equal to
 * `--dry` was mistaken for an execution mode. */
const TAKES_VALUE = new Set([
  '-m', '--message', '--reason', '--notes', '--append-notes', '--description',
  '--title', '--body', '--prompt', '--query', '--pattern', '--status', '--state',
  '--assignee', '--owner', '--priority', '--type', '--with', '-c', '-C',
]);

function modeArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let at = 1; at < argv.length; at += 1) {
    const word = argv[at]!;
    if (TAKES_VALUE.has(word)) { at += 1; continue; }
    out.push(word);
  }
  return out;
}

/**
 * Modes that inspect the executable or preview work take precedence over its
 * action verb. `land --help` did not land, `git push --dry-run` did not push,
 * and `prettier --check` did not format anything.
 */
function intentOnlyStage(head: string, argv: string[]): Stage | null {
  const args = modeArgs(argv);
  const called = commandName(head);
  const help = args.includes('--help') || args[0] === 'help' ||
    (args.length === 1 && args[0] === '-h' && (SHORT_HELP.has(head) || argv[0]!.includes('machinery/')));
  if (help) return { text: `Read the ${brief(called)} options`, kind: 'read', grave: false, intentOnly: true };

  const version = args.includes('--version') || args[0] === 'version' || (args.length === 1 && args[0] === '-V');
  if (version) return { text: `Checked the ${brief(called)} version`, kind: 'read', grave: false, intentOnly: true };

  const dry = args.includes('--dry-run') || args.includes('--dry') ||
    ((head === 'git' && args[0] === 'clean') || head === 'make') && args.includes('-n');
  if (dry) return { text: `Checked what ${brief(called)} would do`, kind: 'read', grave: false, intentOnly: true };

  if (head === 'git' && args[0] === 'diff' && args.includes('--check')) {
    return { text: 'Checked the diff', kind: 'vcs', grave: false, intentOnly: true };
  }
  if (head === 'git' && args[0] === 'apply' && args.includes('--check')) {
    return { text: 'Checked whether a patch applies', kind: 'vcs', grave: false, intentOnly: true };
  }
  if (head === 'cargo' && args[0] === 'fmt' && args.includes('--check')) {
    return { text: 'Checked Rust formatting', kind: 'lint', grave: false, intentOnly: true };
  }
  if (head === 'prettier' && args.includes('--check')) {
    return { text: 'Checked formatting', kind: 'lint', grave: false, intentOnly: true };
  }
  if (head === 'black' && args.includes('--check')) {
    return { text: 'Checked Python formatting', kind: 'lint', grave: false, intentOnly: true };
  }
  if (head === 'ruff' && args[0] === 'format' && args.includes('--check')) {
    return { text: 'Checked Python formatting', kind: 'lint', grave: false, intentOnly: true };
  }
  return null;
}

/** A link that was deliberately passed over rather than one nothing could name. */
const DROPPED = 'dropped';

/**
 * What one link did — a stage, DROPPED when the link was never a thing done,
 * or null when this link did something no rule here has a word for.
 *
 * The difference between the last two is the whole reason a `| head -20` does
 * not print "and 1 more": cutting output down is how a command is read, not a
 * second thing it did.
 */
function linkStage(argv: string[], alreadyReal: boolean): Stage | typeof DROPPED | null {
  if (!argv.length) return DROPPED;
  const head = named(argv[0]!);

  const intent = intentOnlyStage(head, argv);
  if (intent) return intent;

  const heavy = graveStage(head, argv);
  if (heavy) return heavy;

  if (PLUMBING.indexOf(head) >= 0) return DROPPED;
  if (alreadyReal && TRIMMERS.indexOf(head) >= 0) return DROPPED;

  if (head === 'npm' || head === 'pnpm' || head === 'yarn' || head === 'npx') {
    const said = nodePackage(argv);
    return { text: said.said, kind: said.kind, grave: false };
  }

  const rule = HEADS[head];
  if (!rule) {
    // Executable scripts are common in project tooling. Their filename is a
    // useful human label even when this app has never seen that script before.
    if (/\.(?:py|mjs|cjs|js|ts|tsx|sh)$/.test(head) || argv[0]!.includes('machinery/board/')) {
      const stem = head.replace(/\.(?:py|mjs|cjs|js|ts|tsx|sh)$/, '').replaceAll('-', ' ');
      const text = has(argv, '--help', '-h') ? `Read the ${brief(stem)} options` : `Ran ${brief(stem)}`;
      return { text, kind: has(argv, '--help', '-h') ? 'read' : 'script', grave: false };
    }
    return null;
  }
  const text = rule.say(argv);
  if (!text) return null;

  let kind = rule.kind;
  if (head === 'cargo') kind = CARGO_KIND[argv[1] ?? ''] ?? 'build';
  if (head === 'go') kind = GO_KIND[argv[1] ?? ''] ?? 'build';
  if (head === 'docker' && argv[1] === 'build') kind = 'build';
  if (head === 'docker' && argv[1] === 'run') kind = 'run';
  if (head === 'docker' && argv[1] === 'compose' && argv[2] === 'exec') kind = 'run';
  if (head === 'docker' && argv[1] === 'compose' && argv[2] === 'build') kind = 'build';
  if (head === 'sed' && !has(argv, '-i')) kind = 'read';
  if (head === 'next' || head === 'vite') kind = startsOrBuilds(object(argv, 1)).kind;
  if (head === 'node' && (text.startsWith('Checked ') || text.startsWith('Measured '))) kind = 'test';
  if (head === 'codex' && text.startsWith('Generated ')) kind = 'build';
  return { text, kind, grave: false };
}

/** A JavaScript string literal passed as an object property. */
function jsStringAfter(text: string, property: string): string | null {
  const at = new RegExp(`(?:\\b${property}|["']${property}["'])\\s*:\\s*`).exec(text);
  if (!at) return null;
  const from = at.index + at[0].length;
  const quote = text.charAt(from);
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let out = '';
  for (let i = from + 1; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === quote) return out;
    if (char !== '\\') { out += char; continue; }
    const next = text.charAt(++i);
    if (!next) break;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else out += next;
  }
  // Older stored rows may end at the payload limit halfway through a very
  // large programmatic call. The useful command prefix is still better than
  // throwing the entire row back to raw JavaScript.
  return out || null;
}

/**
 * Older Codex rollouts stored their programmatic orchestration call as Bash.
 * Recognising the envelope here repairs those rows on read and protects
 * imports from any provider version that emits the same shape.
 */
function agentEnvelopeDid(text: string, shellDepth: number): Ran | null {
  const code = CODE_MODE_START.test(text);
  if (code && /\btools\.(?:exec_command|exec)\s*\(/.test(text)) {
    const command = jsStringAfter(text, 'cmd');
    if (command) return whatACommandDid(command, shellDepth + 1);
  }
  if (code && /\btools\.(?:write_stdin|wait)\s*\(/.test(text)) {
    return { said: 'Waited for a running command', kind: 'wait', grave: false };
  }
  if ((code && /\btools\.apply_patch\s*\(/.test(text)) || text.indexOf('*** Begin Patch') >= 0) {
    const paths: string[] = [];
    const pattern = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
    const patch = text.replaceAll('\\n', '\n');
    let hit: RegExpExecArray | null;
    while ((hit = pattern.exec(patch))) if (hit[1]) paths.push(hit[1]);
    const target = paths[0] ? brief(place(paths[0])) : '';
    return {
      said: paths.length > 1 ? `Changed ${paths.length} files` : target ? `Changed ${target}` : 'Changed files',
      kind: 'edit', grave: false,
    };
  }
  if (code && /\btools\.view_image\s*\(/.test(text)) {
    const path = jsStringAfter(text, 'path');
    return { said: path ? `Looked at ${brief(place(path))}` : 'Looked at an image', kind: 'read', grave: false };
  }
  if (code && /\btools\.web__run\s*\(/.test(text)) {
    return { said: /(?:\bsearch_query|["']search_query["'])\s*:/.test(text) ? 'Searched the web' : 'Used the browser', kind: 'web', grave: false };
  }
  if (code && /^(?:const|let|var)\s/.test(text)) {
    return { said: 'Ran an agent helper script', kind: 'script', grave: false };
  }
  return null;
}

/** Several semantic commands carried by one provider call, as one result. */
function commandsDid(commands: string[], shellDepth: number): Ran | null {
  const ran = commands
    .map((command) => whatACommandDid(command, shellDepth + 1))
    .filter((result): result is Ran => result !== null);
  if (!ran.length) return null;
  if (ran.length === 1) return ran[0]!;

  // The provider made these calls in this order. Grave work takes one of the
  // visible slots even when several harmless calls came before it, exactly as
  // it does for a shell chain below.
  const grave = ran.some((result) => result.grave);
  const wanted = ran.filter((result) => result.grave)
    .concat(ran.filter((result) => !result.grave))
    .slice(0, MOST_SHOWN);
  const shown = ran.filter((result) => wanted.includes(result));
  let said = shown.map((result, i) => i === 0 ? result.said : joined(result.said)).join(', then ');
  const left = ran.length - shown.length;
  if (left) said += `, and ${left} more`;
  return { said, kind: grave ? 'grave' : shown[0]!.kind, grave };
}

/** One shell command, as a sentence. Null when no rule here can name it. */
export function whatACommandDid(command: string, shellDepth = 0): Ran | null {
  const text = command.trim();
  if (!text) return null;

  // Decode provider code mode and peel process/shell/remote/container wrappers
  // before any semantic rule sees the command. `Bash`, `exec`, JavaScript and
  // `/bin/bash -lc` are transport; the executable beneath them is the work.
  // Dynamic code and unrecognised wrappers stay on the old raw/fallback path.
  // Do not search an arbitrary (sometimes 20KB) shell script for JavaScript
  // call names. Observed code-mode envelopes have a declared pragma or start
  // as orchestration statements.
  const codeMode = CODE_MODE_START.test(text) && isCodeModeEnvelope(text);
  if (shellDepth < 8 && (codeMode || COMMAND_ENVELOPE.test(text) || SETTING_ENVELOPE.test(text))) {
    const source = codeMode ? 'code-mode' : 'direct';
    const normalized = normalizeCommands(text, source);
    const semantic = normalized.commands.map((item) => item.command);
    const changed = semantic.length > 1 || (semantic.length === 1 && semantic[0]!.trim() !== text);
    if (changed) {
      const inner = commandsDid(semantic, shellDepth);
      if (inner) return inner;
    }
  }

  const envelope = shellDepth < 4 ? agentEnvelopeDid(text, shellDepth) : null;
  if (envelope) return envelope;

  const stages: Stage[] = [];
  let missed = 0;
  let where = '';

  if (IS_SCRIPT.test(shellSyntax(text))) {
    const only = scriptStage(text);
    if (!only) {
      const hidden = graveBackstop(text);
      return hidden ? { said: hidden.did, kind: 'grave', grave: true } : null;
    }
    stages.push(only);
  } else {
    const chain = commandLinks(text);
    for (let i = 0; i < chain.length; i++) {
      if (i >= MOST_LINKS) {
        missed += chain.length - i;
        break;
      }
      const link = chain[i]!;
      const argv = headOf(stripped(words(link.text)));
      // A folder change is WHERE a command ran and never WHAT it did. A quarter
      // of his commands open with one, and naming it as a stage named nothing.
      if (argv.length && named(argv[0]!) === 'cd') {
        if (!where) where = folder(argv);
        continue;
      }
      // Search/read tools after a pipe merely shape the previous command's
      // output. After `&&`, `||`, `;`, or a newline they are real work and
      // must be named in the transcript.
      const stage = linkStage(argv, link.piped && stages.length > 0);
      if (stage === null) missed++;
      else if (stage !== DROPPED) stages.push(stage);
    }
  }

  if (!stages.length) {
    const hidden = graveBackstop(text);
    return hidden ? { said: hidden.did, kind: 'grave', grave: true } : null;
  }

  // Whatever the chain reader could not see. A `rm` inside `sh -c '…'` is one
  // word to it and a delete to the machine.
  if (!stages.some((s) => s.grave) && !stages.every((s) => s.intentOnly)) {
    const hidden = graveBackstop(text);
    if (hidden) stages.push({ text: hidden.did, kind: 'grave', grave: true });
  }

  // Grave stages go in first, so one can never be pushed off the end by three
  // harmless ones in front of it — then the order the reader saw is put back.
  const wanted = stages.filter((s) => s.grave).concat(stages.filter((s) => !s.grave)).slice(0, MOST_SHOWN);
  const shown = stages.filter((s) => wanted.indexOf(s) >= 0);
  const left = stages.length - shown.length + missed;

  let said = shown.map((s, i) => (i === 0 ? s.text : joined(s.text))).join(', then ');
  if (left > 0) said += `, and ${left} more`;
  if (where && said.indexOf(where) < 0) said += ` in ${where}`;

  const grave = stages.some((s) => s.grave);
  return { said, kind: grave ? 'grave' : shown[0]!.kind, grave };
}

/** The folder a `cd` moved into, when it is a folder worth naming. */
function folder(argv: string[]): string {
  const target = object(argv, 1);
  if (!target || target === '.' || target === '-' || target === '~' || target.charAt(0) === '$') return '';
  return leaf(target);
}

// ---------------------------------------------------------------------------
// The tools that are not commands
// ---------------------------------------------------------------------------

/** A string argument, or empty when the call did not carry one. */
function arg(input: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = input[name];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

/**
 * The path a call names, or the words for one when it named none.
 *
 * A recorded call from an older build can arrive without the argument this
 * build expects, and "Read " with nothing after it is a worse row than the one
 * this file replaced.
 */
function file(input: Record<string, unknown>, ...names: string[]): string {
  const path = arg(input, ...names);
  return path ? brief(place(path)) : 'a file';
}

/** The browser calls that actually turn up, in the words a reader would use. */
const BROWSER: Record<string, string> = {
  take_screenshot: 'Looked at the screen',
  take_snapshot: 'Read the page',
  navigate_page: 'Opened a page',
  new_page: 'Opened a page',
  close_page: 'Closed a page',
  list_pages: 'Listed the open pages',
  select_page: 'Switched pages',
  click: 'Clicked something on the page',
  fill: 'Typed into the page',
  fill_form: 'Filled in a form',
  hover: 'Hovered over something',
  press_key: 'Pressed a key',
  type_text: 'Typed into the page',
  resize_page: 'Resized the window',
  wait_for: 'Waited for the page',
  evaluate_script: 'Ran a script in the page',
  list_console_messages: 'Read the console',
  get_console_message: 'Read the console',
  list_network_requests: 'Read the network traffic',
  get_network_request: 'Read a network request',
  performance_start_trace: 'Started measuring the page',
  performance_stop_trace: 'Stopped measuring the page',
  lighthouse_audit: 'Audited the page',
  emulate: 'Pretended to be another device',
};

/** `mcp__chrome-devtools__take_screenshot` → what that actually is. */
function mcpSaid(name: string, input: Record<string, unknown>): Ran | null {
  const identity = name.startsWith('mcp__')
    ? { server: name.split('__')[1] ?? '', method: name.split('__').slice(2).join('__') }
    : { server: name.slice(0, name.indexOf('/')), method: name.slice(name.indexOf('/') + 1) };
  if (identity.server === 'chrome-devtools') {
    const did = BROWSER[identity.method];
    if (did) return { said: did, kind: 'web', grave: false };
  }
  const action = normalizeServiceAction(name, input, {
    readOnlyHint: input.readOnlyHint === true,
    destructiveHint: input.destructiveHint === true,
  });
  return action ? { said: action.summary, kind: action.risk === 'destructive' ? 'grave' : 'net', grave: action.risk === 'destructive' } : null;
}

/**
 * Every tool the chat can call that is not a shell command.
 *
 * `Grep`, `Glob` and `WebFetch` are the kit's own names for these, and a row
 * that prints one is showing the reader the machine's word rather than his —
 * the same fault `machine-words.ts` answers for the machine's states.
 */
const CALLS: Record<string, (input: Record<string, unknown>) => Ran | null> = {
  Read: (i) => ({ said: `Read ${file(i, 'file_path', 'notebook_path')}`, kind: 'read', grave: false }),
  NotebookRead: (i) => ({ said: `Read ${file(i, 'notebook_path')}`, kind: 'read', grave: false }),
  Write: (i) => ({ said: `Wrote ${file(i, 'file_path')}`, kind: 'edit', grave: false }),
  Edit: (i) => ({ said: `Changed ${file(i, 'file_path')}`, kind: 'edit', grave: false }),
  NotebookEdit: (i) => ({ said: `Changed ${file(i, 'notebook_path')}`, kind: 'edit', grave: false }),
  MultiEdit: (i) => {
    const many = Array.isArray(i.edits) ? i.edits.length : 0;
    const path = file(i, 'file_path');
    return { said: many > 1 ? `Made ${many} changes to ${path}` : `Changed ${path}`, kind: 'edit', grave: false };
  },
  Grep: (i) => {
    const pattern = arg(i, 'pattern');
    const where = arg(i, 'path', 'glob');
    return {
      said: pattern
        ? `Searched for ${brief(pattern, 32)}${where ? ` in ${brief(place(where), 28)}` : ''}`
        : 'Searched the files',
      kind: 'search',
      grave: false,
    };
  },
  Glob: (i) => {
    const pattern = arg(i, 'pattern');
    return {
      said: pattern ? `Listed the files matching ${brief(pattern, 32)}` : 'Listed the files',
      kind: 'search',
      grave: false,
    };
  },
  LSP: (i) => {
    const operation = arg(i, 'operation').replace(/[_-]/g, ' ');
    const path = arg(i, 'filePath', 'file_path');
    return {
      said: operation ? `${/diagnostic/i.test(operation) ? 'Read' : 'Looked up'} ${brief(operation, 36)}${path ? ` in ${brief(place(path), 28)}` : ''}` : 'Asked the language server',
      kind: /diagnostic/i.test(operation) ? 'read' : 'search',
      grave: false,
    };
  },
  BashOutput: () => ({ said: 'Checked on a command left running', kind: 'system', grave: false }),
  Wait: () => ({ said: 'Waited for a running command', kind: 'wait', grave: false }),
  wait: () => ({ said: 'Waited for a running command', kind: 'wait', grave: false }),
  KillShell: () => ({ said: 'Stopped a command left running', kind: 'grave', grave: true }),
  Agent: (i) => {
    const what = arg(i, 'description', 'prompt', 'message');
    const who = arg(i, 'subagent_type', 'task_name');
    const article = who && /^[aeiou]/i.test(who) ? 'an' : 'a';
    return { said: `Sent off ${who ? `${article} ${who}` : 'a helper'}${what ? ` to ${brief(what, 48)}` : ''}`, kind: 'agent', grave: false };
  },
  Task: (i) => CALLS.Agent!(i),
  SendMessage: (i) => ({ said: `Messaged ${brief(arg(i, 'to')) || 'a helper'}`, kind: 'agent', grave: false }),
  ListAgents: () => ({ said: 'Listed the helpers', kind: 'agent', grave: false }),
  spawn_agent: (i) => CALLS.Agent!(i),
  followup_task: (i) => ({ said: `Gave ${brief(arg(i, 'target')) || 'a helper'} more work`, kind: 'agent', grave: false }),
  send_message: (i) => ({ said: `Messaged ${brief(arg(i, 'target')) || 'a helper'}`, kind: 'agent', grave: false }),
  interrupt_agent: (i) => ({ said: `Stopped ${brief(arg(i, 'target')) || 'a helper'}`, kind: 'grave', grave: true }),
  close_agent: (i) => ({ said: `Closed ${brief(arg(i, 'target')) || 'a helper'}`, kind: 'grave', grave: true }),
  resume_agent: (i) => ({ said: `Started ${brief(arg(i, 'id')) || 'a helper'} again`, kind: 'agent', grave: false }),
  list_agents: () => ({ said: 'Listed the helpers', kind: 'agent', grave: false }),
  wait_agent: (i) => ({
    said: `Waited for ${brief(arg(i, 'target', 'id')) || 'a helper'}`,
    kind: 'agent',
    grave: false,
  }),
  TaskCreate: (i) => {
    const what = arg(i, 'description', 'title');
    return { said: what ? `Started work on ${brief(what, 48)}` : 'Started a piece of work', kind: 'agent', grave: false };
  },
  TaskUpdate: () => ({ said: 'Moved a piece of work on', kind: 'agent', grave: false }),
  TaskGet: () => ({ said: 'Read a piece of work', kind: 'agent', grave: false }),
  TaskOutput: () => ({ said: 'Read what a helper came back with', kind: 'agent', grave: false }),
  TaskStop: () => ({ said: 'Stopped a helper', kind: 'grave', grave: true }),
  TaskList: () => ({ said: 'Listed the work in flight', kind: 'agent', grave: false }),
  TeamCreate: () => ({ said: 'Started a helper team', kind: 'agent', grave: false }),
  TeamDelete: () => ({ said: 'Removed a helper team', kind: 'grave', grave: true }),
  Skill: (i) => {
    const named2 = arg(i, 'skill');
    return { said: named2 ? `Ran the ${brief(named2)} skill` : 'Ran a skill', kind: 'agent', grave: false };
  },
  ToolSearch: () => ({ said: 'Looked for a tool it could use', kind: 'agent', grave: false }),
  Workflow: () => ({ said: 'Ran a workflow', kind: 'agent', grave: false }),
  WebFetch: (i) => ({ said: `Fetched ${address(arg(i, 'url')) || 'a page'}`, kind: 'web', grave: false }),
  WebSearch: (i) => {
    const asked = arg(i, 'query');
    return { said: asked ? `Searched the web for ${brief(asked, 40)}` : 'Searched the web', kind: 'web', grave: false };
  },
  Artifact: (i) => {
    const how = arg(i, 'action') || 'publish';
    if (how === 'read') return { said: 'Read a published page', kind: 'web', grave: false };
    if (how === 'list') return { said: 'Listed the published pages', kind: 'web', grave: false };
    return { said: 'Published a page', kind: 'web', grave: false };
  },
  SendUserFile: () => ({ said: 'Sent you a file', kind: 'agent', grave: false }),
  AskUserQuestion: () => ({ said: 'Asked you a question', kind: 'agent', grave: false }),
  request_user_input: () => ({ said: 'Asked you a question', kind: 'agent', grave: false }),
  SendFeedback: () => ({ said: 'Sent feedback', kind: 'net', grave: false }),
  ExitPlanMode: () => ({ said: 'Put a plan up for you', kind: 'agent', grave: false }),
  EnterPlanMode: () => ({ said: 'Started planning', kind: 'agent', grave: false }),
  EnterWorktree: () => ({ said: 'Moved into a worktree', kind: 'vcs', grave: false }),
  ExitWorktree: () => ({ said: 'Left the worktree', kind: 'vcs', grave: false }),
  Monitor: () => ({ said: 'Watched for something to happen', kind: 'system', grave: false }),
  ScheduleWakeup: () => ({ said: 'Set when to look again', kind: 'system', grave: false }),
  ReportFindings: () => ({ said: 'Reported what the review found', kind: 'agent', grave: false }),
  CronCreate: () => ({ said: 'Scheduled a job', kind: 'system', grave: false }),
  CronList: () => ({ said: 'Listed the scheduled jobs', kind: 'system', grave: false }),
  CronDelete: () => ({ said: 'Removed a scheduled job', kind: 'grave', grave: true }),
};

/**
 * Every command word the table has a sentence for, and every tool that is not
 * a command. Handed out so the check that replays his whole record
 * (scripts/chat-says-what-it-ran.mjs) can report what is covered against the
 * real table rather than against a second copy of it that goes stale.
 */
export const KNOWN_HEADS: string[] = Object.keys(HEADS);
export const KNOWN_TOOLS: string[] = Object.keys(CALLS);

/**
 * What one tool call did, in English, or null to leave it as it was.
 *
 * Null is not a failure: it is the manager's own ruling that a command no rule
 * recognises draws as itself, so the caller keeps whatever it drew before.
 */
export function whatItRan(name: string, input: Record<string, unknown>): Ran | null {
  if (name === 'Bash') {
    const command = input.command;
    return typeof command === 'string' ? whatACommandDid(command) : null;
  }
  if (name.indexOf('mcp__') === 0 || name.includes('/')) return mcpSaid(name, input);
  const known = CALLS[name];
  return known ? known(input ?? {}) : null;
}

/**
 * One line naming what a tool call is about to do, for the feed and the card.
 *
 * The sentence when a rule knows the call, and the raw form when none does —
 * which is the manager's own ruling, that a command nothing recognises stays
 * exactly as it reads today. It lives here rather than beside the driver so
 * that the sidecar and the browser run one copy of the choice between them: a
 * chat says "Ran the tests" while it is running them, asks permission in the
 * same words, and settles onto the very same row (bw-7ks.24.6).
 *
 * Hand it the arguments AFTER they are cut down, the ones that go on the wire.
 * Reading the whole command here and the cut one in the browser would let a
 * delete past the cut be named by one side and not the other.
 */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  return whatItRan(name, input)?.said ?? rawTitle(name, input);
}

/**
 * The raw form a row's title had before any of this: the tool's own name and
 * whatever argument it carried, cut to sixty characters.
 *
 * Kept as its own function because two places want it whatever the rules say.
 * `toolTitle` falls back to it for a command no rule knows — the manager's own
 * ruling — and the permission card uses it and nothing else, on purpose: a
 * reader being asked whether to allow something is entitled to the literal text
 * that will run. `rm -rf dist` and `rm -rf /` are the same sentence and very
 * different commands (bw-7ks.24.6).
 */
export function rawTitle(name: string, input: Record<string, unknown>): string {
  const p = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  if (p) return `${name} ${p.split('/').slice(-2).join('/')}`;
  const cmd = input.command as string | undefined;
  if (cmd) return `${name} ${cmd.slice(0, 60)}`;
  const pattern = (input.pattern ?? input.query) as string | undefined;
  if (pattern) return `${name} ${pattern.slice(0, 60)}`;
  return name;
}

/**
 * Every verb a sentence in this file opens with, in the form for something
 * still happening.
 *
 * The sentences are written for a row, which is read after the fact, so they
 * are all in the past. The line under the last message is read while the thing
 * is going on, and "Ran the tests · 14s" there says the opposite of what the
 * spinner beside it says. English gives no rule that survives `Ran`, `Wrote`,
 * `Threw` and `Read` at once, so the seventy-one are simply written out, and a
 * check holds the list to every sentence the rules can produce — a rule added
 * with a verb nobody listed fails that check rather than printing its past
 * tense at a reader watching it happen (bw-7ks.24.6).
 */
const UNDER_WAY: Record<string, string> = {
  Aborted: 'Aborting', Added: 'Adding', Asked: 'Asking', Blamed: 'Blaming', Built: 'Building',
  Changed: 'Changing', Checked: 'Checking', Claimed: 'Claiming', Cloned: 'Cloning', Created: 'Creating',
  Closed: 'Closing', Commented: 'Commenting', Committed: 'Committing', Continued: 'Continuing',
  Compared: 'Comparing', Copied: 'Copying', Counted: 'Counting', Cut: 'Cutting',
  Deleted: 'Deleting', Diffed: 'Diffing', Downloaded: 'Downloading',
  Fetched: 'Fetching', 'Force-pushed': 'Force-pushing', Formatted: 'Formatting',
  Found: 'Finding', Gave: 'Giving', Installed: 'Installing', Joined: 'Joining', Killed: 'Killing',
  Labeled: 'Labeling', Landed: 'Landing', Left: 'Leaving', Linked: 'Linking', Linted: 'Linting',
  Listed: 'Listing', Looked: 'Looking', Made: 'Making', Measured: 'Measuring',
  Merged: 'Merging', Messaged: 'Messaging', Moved: 'Moving', Opened: 'Opening',
  Picked: 'Picking', Published: 'Publishing', Pulled: 'Pulling', Pushed: 'Pushing',
  Put: 'Putting', Queried: 'Querying', Ran: 'Running', Read: 'Reading',
  Rebased: 'Rebasing', Released: 'Releasing', Removed: 'Removing', Reported: 'Reporting',
  Resolved: 'Resolving', Restarted: 'Restarting', Restored: 'Restoring',
  Reviewed: 'Reviewing', Rewrote: 'Rewriting', Scheduled: 'Scheduling',
  Searched: 'Searching', Sent: 'Sending', Set: 'Setting', Showed: 'Showing', Skipped: 'Skipping',
  Staged: 'Staging', Started: 'Starting', Stashed: 'Stashing', Stopped: 'Stopping',
  Superseded: 'Superseding', Switched: 'Switching', Threw: 'Throwing', Took: 'Taking', Typechecked: 'Typechecking',
  Unpacked: 'Unpacking', Unstaged: 'Unstaging', Waited: 'Waiting',
  Watched: 'Watching', Wrote: 'Writing',
};

/** Where a verb stands: at the front of the sentence, or after a `then`. */
const A_VERB = /(^|, then )([A-Za-z][\w-]*)/g;

/**
 * The same sentence, said of something that has not finished yet.
 *
 * Only for the line under the last message and the chat's own "what it is doing"
 * word. A row keeps the past tense, because by the time it is a row it is past.
 * A verb the list does not hold is left exactly as it was, so nothing is ever
 * mangled into a word that is not English.
 */
export function whileItRuns(said: string): string {
  return said.replace(A_VERB, (whole, lead: string, verb: string) => {
    const now = UNDER_WAY[verb] ?? UNDER_WAY[verb.charAt(0).toUpperCase() + verb.slice(1)];
    if (!now) return whole;
    return lead + (lead === '' ? now : now.charAt(0).toLowerCase() + now.slice(1));
  });
}

/** Every verb the sentences open with, for the check that holds the two lists together. */
export const UNDER_WAY_VERBS: string[] = Object.keys(UNDER_WAY);
