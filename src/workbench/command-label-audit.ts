import { normalizeCommands } from './command-normalization.ts';

import type { Ran } from './said-what-it-ran.ts';

/**
 * Evidence about whether a command's friendly sentence agrees with an intent
 * the invocation states unambiguously.
 *
 * A label existing is deliberately not evidence. Most commands need a person
 * or a tool-specific oracle to judge them and therefore remain `unverified`.
 */
export type CommandLabelVerdict =
  | { status: 'verified'; intent: ExplicitIntent }
  | { status: 'contradiction'; intent: ExplicitIntent; reason: string }
  | { status: 'unverified' }
  | { status: 'uncovered'; intent: ExplicitIntent | null };

export type ExplicitIntent = 'help' | 'version' | 'dry-run' | 'destructive' | 'board' | 'git' | 'runtime' | 'family' | 'plumbing';

const SUBCOMMAND_TOOLS = new Set([
  'bd', 'cargo', 'codex', 'docker', 'gh', 'git', 'go', 'job', 'kubectl', 'npm',
  'npx', 'pnpm', 'report', 'systemctl', 'yarn', 'atelier',
]);

const SAFE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  bd: new Set(['blocked', 'children', 'close', 'comments', 'create', 'doctor', 'dolt', 'gate', 'help', 'label', 'list', 'merge-slot', 'note', 'prime', 'ready', 'reclaim', 'remember', 'search', 'set-state', 'show', 'stats', 'supersede', 'unclaim', 'update']),
  job: new Set(['cancel', 'epic', 'find', 'new', 'start', 'under', 'upgrade']),
  report: new Set(['list', 'new']),
  atelier: new Set(['run', 'init', 'project', 'tool', 'hook', 'where', 'service']),
};

const BEHAVIOR_FLAGS = new Set([
  '--abort', '--apply', '--cached', '--check', '--continue', '--delete', '--dry',
  '--dry-run', '--fix', '--force', '--force-with-lease', '--hard', '--help',
  '--list', '--no-emit', '--skip', '--staged', '--version', '--watch', '--write',
  '-D', '-V', '-d', '-f', '-h', '-n', '-w',
]);

const CLI_WITH_SHORT_HELP = new Set([
  'bd', 'cargo', 'codex', 'docker', 'gh', 'git', 'go', 'job', 'kubectl', 'land',
  'make', 'npm', 'npx', 'pnpm', 'report', 'review', 'yarn', 'check',
]);

const SAYS_DESTRUCTION = /delet|kill|remov|shred|truncat|threw away|formatted|wiped|force-push/i;

function hasCommandSubstitution(command: string): boolean {
  let quote = '';
  for (let at = 0; at < command.length - 1; at += 1) {
    const char = command[at]!;
    if (quote === "'") { if (char === "'") quote = ''; continue; }
    if (quote === '"') {
      if (char === '\\') { at += 1; continue; }
      if (char === '"') { quote = ''; continue; }
      if (char === '$' && command[at + 1] === '(' && command[at + 2] !== '(') return true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '\\') { at += 1; continue; }
    if (char === '$' && command[at + 1] === '(' && command[at + 2] !== '(') return true;
  }
  return false;
}

/** A small shell lexer used only by the independent audit. Compound commands
 * have more than one intent and are left unverified rather than guessed at. */
function simpleWords(command: string): string[] | null {
  const out: string[] = [];
  let word = '';
  let quote = '';
  let quoted = false;
  const push = () => {
    if (!word) return;
    out.push(quoted ? `\0${word}` : word);
    word = '';
    quoted = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (!quote && char === '\\' && (command[i + 1] === '\n' || command[i + 1] === '\r')) {
      if (command[i + 1] === '\r' && command[i + 2] === '\n') i += 1;
      i += 1;
      continue;
    }
    if (quote) {
      if (char === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]!;
      else if (char === quote) quote = '';
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; quoted = true; continue; }
    if (char === '\\' && i + 1 < command.length) { word += command[++i]!; continue; }
    if (char === '\n' || char === '\r') return null;
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === ';' || char === '|' || char === '&' || char === '(' || char === ')') return null;
    word += char;
  }
  if (quote) return null;
  push();
  return out;
}

const base = (word: string): string => word.slice(word.lastIndexOf('/') + 1).toLowerCase();

const WRAPPER_SKIP: Record<string, number> = {
  sudo: 0, time: 0, setsid: 0, nohup: 0, command: 0, stdbuf: 0, exec: 0,
  xargs: 0, rtk: 0, 'cargo-lim': 0, timeout: 1, nice: 1, ionice: 1,
};

/** Reach the executable that the production classifier reads through. The
 * wrapper is transport, so putting `rtk` or `time` in the corpus profile would
 * group unlike commands and hide disagreements in the actual Git/rg/cargo
 * operation. */
function semanticArgv(argv: string[]): string[] {
  let rest = argv;
  for (let pass = 0; pass < 4 && rest.length; pass += 1) {
    const head = base(rest[0]!.replace(/^\0/, ''));
    const skipped = WRAPPER_SKIP[head];
    if (skipped === undefined) break;
    if (head === 'rtk' && ['gain', 'discover'].includes(rest[1]?.replace(/^\0/, '') ?? '')) break;
    let from = 1 + skipped;
    if (head === 'rtk' && rest[1]?.replace(/^\0/, '') === 'proxy') from = 2;
    rest = rest.slice(from);
    while (rest.length && rest[0]!.replace(/^\0/, '').startsWith('-')) rest = rest.slice(1);
  }
  for (let pass = 0; pass < 4 && rest.length; pass += 1) {
    const head = base(rest[0]!.replace(/^\0/, ''));
    const plain = rest.map((word) => word.replace(/^\0/, ''));
    if (/^(?:python\d*|pypy\d*)$/.test(head)) {
      const marker = plain.indexOf('-m', 1);
      if (marker >= 0 && plain[marker + 1]) {
        rest = [plain[marker + 1]!.split('.').at(-1)!, ...plain.slice(marker + 2)];
        continue;
      }
    }
    const commandMarker = ['uv', 'poetry', 'pipenv', 'rye', 'hatch'].includes(head) ? 'run'
      : head === 'bundle' ? 'exec' : '';
    if (commandMarker && plain[1] === commandMarker && plain[2]) {
      rest = [plain[2]!, ...plain.slice(3)];
      continue;
    }
    break;
  }
  return rest;
}

function invocation(command: string, normalized = false): { head: string; argv: string[] } | null {
  if (!normalized) {
    const semantic = normalizeCommands(command).commands;
    if (semantic.length === 1 && semantic[0]!.command.trim() !== command.trim()) {
      return invocation(semantic[0]!.command, true);
    }
  }
  const words = simpleWords(command);
  if (!words?.length) return null;
  let at = 0;
  while (words[at] === '{' || words[at] === '(') at += 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test((words[at] ?? '').replace(/^\0/, ''))) at += 1;
  if (at >= words.length) return null;
  const argv = semanticArgv(words.slice(at));
  if (!argv.length) return null;
  return { head: base(argv[0]!.replace(/^\0/, '')), argv };
}

/** A privacy-safe description of the invocation shape: no paths, patterns,
 * ids, URLs, code, or other arguments leave this function. */
export function commandLabelProfile(command: string, ran: Ran | null): string | null {
  const call = invocation(command);
  if (!call) return null;
  const argv = call.argv.map((word) => word.replace(/^\0/, ''));
  const head = call.head;
  let at = 1;
  if (head === 'git') {
    while (at < argv.length) {
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(argv[at]!)) { at += 2; continue; }
      if (/^--(?:git-dir|work-tree|namespace)=/.test(argv[at]!)) { at += 1; continue; }
      break;
    }
  }
  let sub = SUBCOMMAND_TOOLS.has(head) && argv[at] && !argv[at]!.startsWith('-') ? argv[at]! : '-';
  const safe = SAFE_SUBCOMMANDS[head];
  if (safe && sub !== '-' && !safe.has(sub)) sub = 'other';
  if ((head === 'docker' && sub === 'compose') || (head === 'bd' && sub === 'dolt')) {
    const nested = argv.slice(at + 1).find((word) => !word.startsWith('-'));
    if (nested) sub += `/${nested}`;
  }
  if (head === 'atelier') {
    if (sub === 'project' && argv[at + 1] === 'mode') sub = 'project/mode';
    else if (sub === 'service') {
      const action = argv[at + 1] && !argv[at + 1]!.startsWith('-') ? argv[at + 1] : 'status';
      sub = `service/${['install', 'uninstall', 'remove', 'status'].includes(action) ? action : 'other'}`;
    } else if (sub === 'hook') sub = 'hook/other';
    else if (sub === 'tool') {
      const tool = argv[at + 1] ?? '';
      if (tool === 'present') {
        const form = argv[at + 2] ?? '';
        sub = `tool/present/${['widget', 'image', 'compare', 'artifact'].includes(form) ? form : 'other'}`;
      } else if (tool === 'board/job') {
        const action = argv[at + 2] ?? '';
        sub = `tool/board/job/${['new', 'under', 'epic', 'cancel', 'upgrade'].includes(action) ? action : 'other'}`;
      } else if (tool === 'board/land') sub = 'tool/board/land';
      else if (tool === 'checks') sub = 'tool/checks';
      else sub = 'tool/other';
    }
  }
  if (head === 'systemctl') {
    sub = argv.slice(1).find((word) => !word.startsWith('-')) ?? '-';
  }
  const profiledFlags = call.argv.slice(1).flatMap((word) => {
    const quoted = word.startsWith('\0');
    const plain = word.replace(/^\0/, '');
    if (!BEHAVIOR_FLAGS.has(plain)) return [];
    return [quoted ? `value:${plain}` : plain];
  });
  const flags = [...new Set(profiledFlags)].sort().join(',') || '-';
  const verb = ran?.said.match(/^[A-Za-z][\w-]*/)?.[0] ?? 'raw';
  return `${head}|${sub}|${flags}|${verb}|${ran?.kind ?? 'raw'}|${ran?.grave ? 'grave' : 'ordinary'}`;
}

/** Intent that the command line itself proves without interpreting its output. */
export function explicitCommandIntent(command: string): ExplicitIntent | null {
  const call = invocation(command);
  if (!call) return null;
  const { head, argv } = call;
  const args = argv.slice(1);
  if (args.includes('--help') || args[0] === 'help' || (args.length === 1 && args[0] === '-h' && CLI_WITH_SHORT_HELP.has(head))) {
    return 'help';
  }
  if (args.includes('--version') || args[0] === 'version' || (args.length === 1 && args[0] === '-V')) return 'version';
  if (args.includes('--dry-run') || args.includes('--dry') ||
    (head === 'git' && args.includes('clean') && args.some((arg) => /^-[^-]*n/.test(arg)))) return 'dry-run';

  if (['rm', 'rmdir', 'shred', 'mkfs', 'truncate', 'unlink', 'killall'].includes(head)) return 'destructive';
  if ((head === 'kill' || head === 'pkill') && !args.includes('-0')) return 'destructive';
  if (head === 'find' && args.includes('-delete')) return 'destructive';
  if (head === 'git') {
    let at = 1;
    while (at < argv.length) {
      const word = argv[at]?.replace(/^\0/, '') ?? '';
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(word)) { at += 2; continue; }
      if (/^--(?:git-dir|work-tree|namespace)=/.test(word)) { at += 1; continue; }
      break;
    }
    const sub = argv[at]?.replace(/^\0/, '') ?? '';
    const gitArgs = argv.slice(at + 1).map((arg) => arg.replace(/^\0/, ''));
    const previewsClean = gitArgs.includes('--dry-run') || gitArgs.some((arg) => /^-[^-]*n/.test(arg));
    if (sub === 'rm' || (sub === 'clean' && !previewsClean)) return 'destructive';
    if (sub === 'reset' && gitArgs.includes('--hard')) return 'destructive';
    if (sub === 'push' && gitArgs.some((arg) => arg === '-f' || arg === '--force' || arg === '--force-with-lease')) return 'destructive';
    if (sub === 'branch' && gitArgs.some((arg) => ['-d', '-D', '--delete'].includes(arg))) return 'destructive';
    if (sub === 'tag' && gitArgs.some((arg) => ['-d', '--delete'].includes(arg))) return 'destructive';
    if (sub === 'worktree' && gitArgs[0] === 'remove') return 'destructive';
  }
  if (head === 'docker' && (args[0] === 'rm' || args[0] === 'rmi' || (args[0] === 'system' && args[1] === 'prune'))) {
    return 'destructive';
  }
  if (head === 'kubectl' && args[0] === 'delete') return 'destructive';
  if (head === 'gio' && args[0] === 'trash') return 'destructive';
  if (head === 'git-branch' && args.some((arg) => ['-d', '-D', '--delete'].includes(arg))) return 'destructive';
  if (head === 'curl') {
    const requestAt = args.findIndex((arg) => arg === '-X' || arg === '--request');
    if (requestAt >= 0 && args[requestAt + 1]?.toUpperCase() === 'DELETE') return 'destructive';
  }
  return null;
}

interface ExpectedLabel {
  intent: ExplicitIntent;
  kinds: readonly Ran['kind'][];
  grave: boolean | null;
  verbs?: readonly string[];
}

const family = (kinds: readonly Ran['kind'][], verbs: readonly string[]): ExpectedLabel => ({
  intent: 'family', kinds, grave: kinds.includes('grave') && kinds.length > 1 ? null : kinds[0] === 'grave', verbs,
});

const READ_VERBS = ['Read', 'Listed', 'Counted', 'Checked', 'Measured', 'Compared', 'Joined', 'Identified', 'Resolved', 'Checksummed', 'Picked', 'Looked', 'Showed'];
const EDIT_VERBS = ['Made', 'Copied', 'Moved', 'Changed', 'Linked', 'Rewrote', 'Formatted', 'Applied', 'Installed', 'Packed', 'Unpacked', 'Worked', 'Saved', 'Updated'];
const FAMILY_EXPECTATIONS: Record<string, ExpectedLabel> = {
  cat: family(['read'], READ_VERBS), head: family(['read'], READ_VERBS), tail: family(['read'], READ_VERBS),
  ls: family(['read'], READ_VERBS), wc: family(['read'], READ_VERBS), stat: family(['read'], READ_VERBS),
  du: family(['read'], READ_VERBS), diff: family(['read'], READ_VERBS), cmp: family(['read'], READ_VERBS),
  join: family(['read'], READ_VERBS), nl: family(['read'], READ_VERBS), file: family(['read'], READ_VERBS),
  identify: family(['read'], [...READ_VERBS, 'Inspected']), md5sum: family(['read'], READ_VERBS), sha256sum: family(['read'], READ_VERBS),
  readlink: family(['read'], READ_VERBS), realpath: family(['read'], READ_VERBS),
  strings: family(['read'], READ_VERBS), pdftotext: family(['read', 'edit'], ['Read', 'Extracted']), pdfinfo: family(['read'], READ_VERBS),
  grep: family(['search'], ['Searched']), rg: family(['search'], ['Searched', 'Listed']), ag: family(['search'], ['Searched']),
  ack: family(['search'], ['Searched']), find: family(['search', 'grave'], ['Looked', 'Deleted']), codegraph: family(['search'], ['Searched']),
  fd: family(['search'], ['Looked']),
  sed: family(['read', 'edit'], ['Read', 'Picked', 'Processed', 'Rewrote']), awk: family(['data'], ['Picked']),
  jq: family(['data'], ['Picked']), base64: family(['data'], ['Converted']), basename: family(['data'], ['Picked']),
  tr: family(['data'], ['Translated']), sqlite3: family(['data'], ['Queried']), psql: family(['data'], ['Queried']),
  mysql: family(['data'], ['Queried']), mongosh: family(['data'], ['Queried']),
  sort: family(['data'], ['Sorted']), uniq: family(['data'], ['Removed']), cut: family(['data'], ['Picked']),
  paste: family(['data'], ['Joined']), comm: family(['data'], ['Compared']), column: family(['data'], ['Aligned']),
  bc: family(['data'], ['Calculated']), xxd: family(['data'], ['Converted']), dirname: family(['data'], ['Picked']),
  mkdir: family(['edit'], EDIT_VERBS), touch: family(['edit'], EDIT_VERBS), cp: family(['edit'], EDIT_VERBS),
  mv: family(['edit'], EDIT_VERBS), ln: family(['edit'], EDIT_VERBS), chmod: family(['edit'], EDIT_VERBS),
  chown: family(['edit'], EDIT_VERBS), tar: family(['edit'], EDIT_VERBS), zip: family(['edit'], EDIT_VERBS),
  unzip: family(['edit'], EDIT_VERBS), gzip: family(['edit'], EDIT_VERBS), patch: family(['edit'], EDIT_VERBS),
  apply_patch: family(['edit'], EDIT_VERBS), install: family(['edit'], EDIT_VERBS), mktemp: family(['edit'], EDIT_VERBS),
  magick: family(['edit'], EDIT_VERBS), convert: family(['edit'], EDIT_VERBS), ffmpeg: family(['edit'], EDIT_VERBS),
  tee: family(['edit'], ['Wrote']),
  pwd: family(['system'], ['Checked']), which: family(['system'], ['Looked']), whereis: family(['system'], ['Looked']),
  ps: family(['system'], ['Listed']), pgrep: family(['system'], ['Looked']), ss: family(['system'], ['Checked']),
  lsof: family(['system'], ['Checked']), netstat: family(['system'], ['Checked']), date: family(['system'], ['Checked']),
  fuser: family(['system'], ['Checked']), printenv: family(['system'], ['Read']), type: family(['system'], ['Looked']),
  systemctl: family(['system'], ['Asked', 'Checked', 'Read', 'Showed', 'Started', 'Stopped', 'Restarted', 'Reloaded', 'Enabled', 'Disabled']),
  getent: family(['system'], ['Read']), free: family(['system'], ['Checked']), journalctl: family(['system'], ['Read']),
  pstree: family(['system'], ['Listed']), uptime: family(['system'], ['Checked']), nproc: family(['system'], ['Counted']),
  findmnt: family(['system'], ['Listed']), whoami: family(['system'], ['Checked']), vmstat: family(['system'], ['Checked']),
  dmesg: family(['system'], ['Read']), ip: family(['system'], ['Checked']), 'xdg-mime': family(['system'], ['Checked']),
  df: family(['system'], ['Checked']),
  curl: family(['net'], ['Fetched', 'Read', 'Sent']), wget: family(['net'], ['Downloaded']), ssh: family(['net'], ['Ran']),
  scp: family(['net'], ['Copied']), rsync: family(['net'], ['Copied']), cloudflared: family(['net'], ['Ran']),
  nslookup: family(['net'], ['Looked']), dig: family(['net'], ['Looked']), gh: family(['net'], ['Asked', 'Opened', 'Read', 'Listed', 'Merged', 'Worked', 'Checked']),
  linear: family(['net'], ['Worked']), nc: family(['net'], ['Used']),
  vitest: family(['test'], ['Ran']), jest: family(['test'], ['Ran']), mocha: family(['test'], ['Ran']),
  ava: family(['test'], ['Ran']), tap: family(['test'], ['Ran']), pytest: family(['test'], ['Ran']),
  unittest: family(['test'], ['Ran']), nose: family(['test'], ['Ran']), rspec: family(['test'], ['Ran']),
  phpunit: family(['test'], ['Ran']), playwright: family(['test', 'read'], ['Ran', 'Listed']), cypress: family(['test'], ['Ran']),
  tsc: family(['build'], ['Typechecked']), mypy: family(['build'], ['Typechecked']), pyright: family(['build'], ['Typechecked']),
  eslint: family(['lint', 'edit'], ['Linted']), prettier: family(['lint', 'edit'], ['Formatted', 'Checked']),
  ruff: family(['lint', 'edit'], ['Linted', 'Formatted', 'Checked']), black: family(['lint', 'edit'], ['Formatted', 'Checked']),
  rustfmt: family(['lint', 'edit'], ['Formatted', 'Checked']),
  python: family(['run', 'script', 'test'], ['Ran', 'Checked', 'Measured']), python2: family(['run', 'script', 'test'], ['Ran']),
  python3: family(['run', 'script', 'test'], ['Ran', 'Checked', 'Measured']), pypy: family(['run', 'script', 'test'], ['Ran']),
  pypy3: family(['run', 'script', 'test'], ['Ran']), node: family(['run', 'script', 'test'], ['Ran', 'Checked', 'Measured']),
  tsx: family(['run', 'test'], ['Ran']), deno: family(['run', 'test'], ['Ran']), bun: family(['run', 'test'], ['Ran']),
  bash: family(['run', 'script', 'grave'], ['Ran', 'Deleted', 'Killed']), sh: family(['run', 'script', 'grave'], ['Ran', 'Deleted', 'Killed']),
  zsh: family(['run', 'script', 'grave'], ['Ran', 'Deleted', 'Killed']), sleep: family(['wait'], ['Waited']),
  atelier: family(['run', 'read', 'edit', 'system', 'script', 'agent', 'test', 'board'], ['Started', 'Read', 'Set', 'Checked', 'Stopped', 'Ran', 'Presented', 'Opened', 'Added', 'Dropped', 'Filled', 'Landed']), 'beads-server': family(['run'], ['Ran']), 'beads-web': family(['run'], ['Ran']),
  claude: family(['agent'], ['Ran']), 'external-review': family(['agent'], ['Ran']),
  codex: family(['run', 'build'], ['Ran', 'Started', 'Generated']), docker: family(['system', 'run', 'build'], ['Asked', 'Listed', 'Read', 'Ran', 'Built', 'Started', 'Stopped', 'Worked', 'Pulled', 'Restarted']),
  kubectl: family(['system'], ['Asked', 'Listed', 'Read', 'Ran', 'Described', 'Applied']), man: family(['read'], ['Read']),
  'redis-cli': family(['data', 'grave'], ['Read', 'Changed', 'Deleted']),
  check: family(['test'], ['Ran']), checks: family(['test'], ['Ran']),
  waive: family(['script'], ['Ran']), copies: family(['script'], ['Ran']), spine: family(['script'], ['Ran']), claim: family(['script'], ['Ran']),
  kill: family(['wait'], ['Checked']),
  wait: family(['wait'], ['Waited']), pip: family(['build', 'read', 'grave'], ['Installed', 'Read', 'Removed', 'Updated']),
  pip3: family(['build', 'read', 'grave'], ['Installed', 'Read', 'Removed', 'Updated']),
  brew: family(['build', 'read', 'grave'], ['Installed', 'Read', 'Removed', 'Updated']),
  perl: family(['run'], ['Ran']), fish: family(['run'], ['Ran']), py_compile: family(['build'], ['Checked']),
  egrep: family(['search'], ['Searched']), html2text: family(['data'], ['Read']), od: family(['data'], ['Read']),
  shuf: family(['data'], ['Shuffled']), env: family(['system'], ['Read']), jobs: family(['system'], ['Listed']),
  disown: family(['system'], ['Detached']), swapon: family(['system'], ['Checked']),
  'fc-list': family(['system'], ['Listed']), 'fc-match': family(['system'], ['Matched']),
  'rsvg-convert': family(['edit'], ['Converted']), pdftoppm: family(['edit'], ['Rendered']),
  '7z': family(['edit'], ['Packed', 'Unpacked']),
};

function expectedLabel(command: string): ExpectedLabel | null {
  // A command substitution adds independently executed actions to the outer
  // invocation. Its composite sentence is audited stage-by-stage instead.
  if (hasCommandSubstitution(command)) return null;
  const call = invocation(command);
  if (!call) return null;
  const argv = call.argv.map((word) => word.replace(/^\0/, ''));
  const head = call.head;
  const args = argv.slice(1);

  if (['cat', 'echo', 'printf', 'tee'].includes(head) && /(?:^|\s)\d*>>?\s*\S+/.test(command)) {
    return family(['edit'], ['Wrote']);
  }

  if (head === 'atelier') {
    const top = args[0] ?? 'run';
    if (top === 'run') return family(['run'], ['Started']);
    if (top === 'init') return family(['edit'], ['Set']);
    if (top === 'where' || top === '--data-dir') return family(['read'], ['Read']);
    if (top === 'project' && args[1] === 'mode') return family(['read'], ['Checked']);
    if (top === 'service') {
      const action = args[1] ?? 'status';
      if (action === 'status') return family(['system'], ['Checked']);
      if (action === 'install') return family(['system'], ['Set']);
      if (action === 'uninstall' || action === 'remove') return family(['system'], ['Stopped']);
      return null;
    }
    if (top === 'hook' && args[1]) return family(['script'], ['Ran']);
    if (top !== 'tool') return null;
    if (args[1] === 'present' && ['widget', 'image', 'compare', 'artifact'].includes(args[2] ?? '')) {
      return family(['agent'], ['Presented']);
    }
    if (args[1] === 'checks') return family(['test'], ['Ran']);
    if (args[1] === 'board/job' && args[2]) return family(['board'], ['Opened', 'Added', 'Dropped', 'Filled', 'Ran']);
    if (args[1] === 'board/land') return family(['board'], ['Landed']);
    return null;
  }

  if (head === 'bd') {
    const sub = args[0] ?? '';
    const verbs: Record<string, readonly string[]> = {
      close: ['Closed'], show: ['Showed'], ready: ['Listed'], list: ['Listed'], blocked: ['Listed'],
      prime: ['Read'], stats: ['Counted'], create: ['Created'], search: ['Searched'], label: ['Labeled', 'Removed'],
      supersede: ['Superseded'], children: ['Listed'], doctor: ['Checked'], unclaim: ['Released'],
      remember: ['Wrote'], update: ['Updated', 'Claimed', 'Wrote', 'Moved'],
      comments: ['Commented', 'Read'], 'merge-slot': ['Took', 'Gave', 'Checked'],
    };
    return { intent: 'board', kinds: ['board'], grave: false, verbs: verbs[sub] };
  }
  if (['job', 'land', 'review', 'report', 'checks'].includes(head)) {
    return { intent: 'board', kinds: [head === 'checks' ? 'test' : 'board'], grave: false };
  }

  if (head === 'git') {
    let at = 1;
    while (at < argv.length) {
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(argv[at]!)) { at += 2; continue; }
      if (/^--(?:git-dir|work-tree|namespace)=/.test(argv[at]!)) { at += 1; continue; }
      break;
    }
    const sub = argv[at] ?? '';
    const rest = argv.slice(at + 1);
    const previewsClean = rest.includes('--dry-run') || rest.some((arg) => /^-[^-]*n/.test(arg));
    const deletes = sub === 'rm' || (sub === 'clean' && !previewsClean) ||
      (sub === 'reset' && rest.includes('--hard')) ||
      (sub === 'push' && rest.some((arg) => ['-f', '--force', '--force-with-lease'].includes(arg))) ||
      (sub === 'branch' && rest.some((arg) => ['-d', '-D', '--delete'].includes(arg))) ||
      (sub === 'tag' && rest.some((arg) => ['-d', '--delete'].includes(arg))) ||
      (sub === 'worktree' && rest[0] === 'remove');
    const verbs: Record<string, readonly string[]> = {
      status: ['Checked'], log: ['Read'], show: ['Showed'], diff: ['Diffed', 'Checked'], add: ['Staged'],
      commit: ['Committed'], push: ['Pushed', 'Force-pushed'], pull: ['Pulled'], fetch: ['Fetched'],
      checkout: ['Checked'], switch: ['Switched'], branch: ['Listed', 'Made', 'Deleted'],
      merge: ['Merged', 'Aborted', 'Continued'], rebase: ['Rebased', 'Aborted', 'Continued', 'Skipped'],
      stash: ['Stashed', 'Took'], reset: ['Unstaged', 'Threw'], restore: ['Restored'], grep: ['Searched'],
      'rev-parse': ['Resolved'], 'merge-base': ['Found'], 'ls-files': ['Listed'], blame: ['Blamed'],
      tag: ['Listed', 'Tagged', 'Deleted'], remote: ['Listed', 'Added', 'Removed', 'Changed'], clone: ['Cloned'],
      init: ['Started'], apply: ['Applied', 'Checked'], am: ['Applied'], cherry: ['Compared'],
      'cherry-pick': ['Cherry-picked', 'Aborted', 'Continued'], describe: ['Named'], shortlog: ['Read'],
      worktree: ['Cut', 'Removed', 'Pruned', 'Listed'], 'show-ref': ['Listed', 'Checked'],
      'for-each-ref': ['Listed'], 'check-ignore': ['Checked'], 'write-tree': ['Wrote'], rm: ['Deleted'],
    };
    return { intent: 'git', kinds: [deletes ? 'grave' : 'vcs'], grave: deletes, verbs: verbs[sub] };
  }

  if (head === 'next' || head === 'vite') {
    const running = ['dev', 'start', 'preview', 'serve'].includes(args[0] ?? '');
    return { intent: 'runtime', kinds: [running ? 'run' : 'build'], grave: false, verbs: [running ? 'Started' : 'Built'] };
  }
  if (head === 'cargo') {
    const kinds: Record<string, Ran['kind']> = { test: 'test', bench: 'test', run: 'run', clippy: 'lint', fmt: 'lint', build: 'build', check: 'build', doc: 'build' };
    return family([kinds[args[0] ?? ''] ?? 'build'], ['Ran', 'Benchmarked', 'Linted', 'Formatted', 'Built', 'Checked', 'Added', 'Updated', 'Read']);
  }
  if (head === 'go') {
    const kinds: Record<string, Ran['kind']> = { test: 'test', run: 'run', vet: 'lint', fmt: 'lint', build: 'build' };
    return family([kinds[args[0] ?? ''] ?? 'build'], ['Ran', 'Built', 'Vetted', 'Formatted']);
  }
  if (['npm', 'pnpm', 'yarn', 'npx'].includes(head)) {
    return family(['run', 'test', 'build', 'lint', 'edit', 'read', 'grave'], ['Ran', 'Started', 'Built', 'Installed', 'Removed', 'Read', 'Audited', 'Packed', 'Typechecked', 'Linted', 'Formatted', 'Checked']);
  }
  if (['true', 'false', 'echo', 'printf', 'cd', ':'].includes(head)) {
    return { intent: 'plumbing', kinds: [], grave: false, verbs: [] };
  }
  const expected = FAMILY_EXPECTATIONS[head];
  if (expected) return expected;
  if (/\.(?:py|mjs|cjs|js|ts|tsx|sh)$/.test(head)) {
    return family(['script', 'run', 'test', 'build', 'lint', 'edit', 'read'], ['Ran', 'Benchmarked', 'Built', 'Linted', 'Formatted', 'Started', 'Read']);
  }
  return null;
}

/** Judge only what the independent invocation evidence can settle. */
export function auditCommandLabel(command: string, ran: Ran | null): CommandLabelVerdict {
  const intent = explicitCommandIntent(command);
  const expected = intent ? null : expectedLabel(command);
  const auditedIntent = intent ?? expected?.intent ?? null;
  if (!ran && expected?.intent === 'plumbing') return { status: 'verified', intent: 'plumbing' };
  if (!ran) return { status: 'uncovered', intent: auditedIntent };
  if (!auditedIntent) return { status: 'unverified' };

  if (intent === 'help') {
    if (ran.kind === 'read' && /^Read\b.*\boptions\b/i.test(ran.said) && !ran.grave) return { status: 'verified', intent };
    return { status: 'contradiction', intent, reason: 'help invocation is not labelled as reading options' };
  }
  if (intent === 'version') {
    if (ran.kind === 'read' && /\b(?:checked|read)\b.*\bversion\b/i.test(ran.said) && !ran.grave) return { status: 'verified', intent };
    return { status: 'contradiction', intent, reason: 'version invocation is not labelled as reading a version' };
  }
  if (intent === 'dry-run') {
    if (ran.kind === 'read' && /\b(?:checked|previewed|would do)\b/i.test(ran.said) && !ran.grave) return { status: 'verified', intent };
    return { status: 'contradiction', intent, reason: 'dry-run invocation is labelled as completed work' };
  }
  if (intent === 'destructive') {
    if (ran.grave && ran.kind === 'grave' && SAYS_DESTRUCTION.test(ran.said)) return { status: 'verified', intent };
    return { status: 'contradiction', intent, reason: 'destructive invocation is not labelled as destructive' };
  }
  const verb = ran.said.match(/^[A-Za-z][\w-]*/)?.[0] ?? '';
  if (expected && expected.kinds.includes(ran.kind) && (expected.grave === null || ran.grave === expected.grave) && (!expected.verbs || expected.verbs.includes(verb))) {
    return { status: 'verified', intent: expected.intent };
  }
  return {
    status: 'contradiction', intent: auditedIntent,
    reason: `expected ${expected?.kinds.join('/') ?? 'known'} ${expected?.grave ? 'grave' : 'ordinary'} intent`,
  };
}
