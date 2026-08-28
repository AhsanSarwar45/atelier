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

export type ExplicitIntent = 'help' | 'version' | 'dry-run' | 'destructive' | 'board' | 'git' | 'runtime';

const SUBCOMMAND_TOOLS = new Set([
  'bd', 'cargo', 'codex', 'docker', 'gh', 'git', 'go', 'job', 'kubectl', 'npm',
  'npx', 'pnpm', 'report', 'systemctl', 'yarn',
]);

const SAFE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  bd: new Set(['blocked', 'children', 'close', 'comments', 'create', 'doctor', 'dolt', 'gate', 'help', 'label', 'list', 'merge-slot', 'note', 'prime', 'ready', 'reclaim', 'remember', 'search', 'set-state', 'show', 'stats', 'supersede', 'unclaim', 'update']),
  job: new Set(['cancel', 'epic', 'find', 'new', 'start', 'under', 'upgrade']),
  report: new Set(['list', 'new']),
};

const BEHAVIOR_FLAGS = new Set([
  '--abort', '--apply', '--cached', '--check', '--continue', '--delete', '--dry',
  '--dry-run', '--fix', '--force', '--force-with-lease', '--hard', '--help',
  '--list', '--no-emit', '--skip', '--staged', '--version', '--watch', '--write',
  '-D', '-V', '-d', '-f', '-h', '-n', '-w',
]);

const CLI_WITH_SHORT_HELP = new Set([
  'bd', 'cargo', 'codex', 'docker', 'gh', 'git', 'go', 'job', 'kubectl', 'land',
  'make', 'npm', 'npx', 'pnpm', 'report', 'review', 'yarn',
]);

const SAYS_DESTRUCTION = /delet|kill|remov|shred|threw away|formatted|wiped|force-push/i;

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
  return rest;
}

function invocation(command: string): { head: string; argv: string[] } | null {
  const words = simpleWords(command);
  if (!words?.length) return null;
  let at = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '')) at += 1;
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
    (head === 'git' && args.includes('clean') && args.includes('-n'))) return 'dry-run';

  if (['rm', 'rmdir', 'shred', 'mkfs', 'truncate', 'killall'].includes(head)) return 'destructive';
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
    if (sub === 'rm' || (sub === 'clean' && !gitArgs.includes('-n') && !gitArgs.includes('--dry-run'))) return 'destructive';
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
  return null;
}

interface ExpectedLabel {
  intent: ExplicitIntent;
  kind: Ran['kind'];
  grave: boolean;
  verbs?: readonly string[];
}

function expectedLabel(command: string): ExpectedLabel | null {
  const call = invocation(command);
  if (!call) return null;
  const argv = call.argv.map((word) => word.replace(/^\0/, ''));
  const head = call.head;
  const args = argv.slice(1);

  if (head === 'bd') {
    const sub = args[0] ?? '';
    const verbs: Record<string, readonly string[]> = {
      close: ['Closed'], show: ['Showed'], ready: ['Listed'], list: ['Listed'], blocked: ['Listed'],
      prime: ['Read'], stats: ['Counted'], create: ['Created'], search: ['Searched'], label: ['Labeled', 'Removed'],
      supersede: ['Superseded'], children: ['Listed'], doctor: ['Checked'], unclaim: ['Released'],
      remember: ['Wrote'], update: ['Updated', 'Claimed', 'Wrote', 'Moved'],
      comments: ['Commented', 'Read'], 'merge-slot': ['Took', 'Gave', 'Checked'],
    };
    return { intent: 'board', kind: 'board', grave: false, verbs: verbs[sub] };
  }
  if (['job', 'land', 'review', 'report', 'checks'].includes(head)) {
    return { intent: 'board', kind: head === 'checks' ? 'test' : 'board', grave: false };
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
    const deletes = sub === 'rm' || (sub === 'clean' && !rest.includes('-n') && !rest.includes('--dry-run')) ||
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
    return { intent: 'git', kind: deletes ? 'grave' : 'vcs', grave: deletes, verbs: verbs[sub] };
  }

  if (head === 'next' || head === 'vite') {
    const running = ['dev', 'start', 'preview', 'serve'].includes(args[0] ?? '');
    return { intent: 'runtime', kind: running ? 'run' : 'build', grave: false, verbs: [running ? 'Started' : 'Built'] };
  }
  if (head === 'awk') return { intent: 'runtime', kind: 'data', grave: false, verbs: ['Picked'] };
  return null;
}

/** Judge only what the independent invocation evidence can settle. */
export function auditCommandLabel(command: string, ran: Ran | null): CommandLabelVerdict {
  const intent = explicitCommandIntent(command);
  const expected = intent ? null : expectedLabel(command);
  const auditedIntent = intent ?? expected?.intent ?? null;
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
  if (expected && ran.kind === expected.kind && ran.grave === expected.grave && (!expected.verbs || expected.verbs.includes(verb))) {
    return { status: 'verified', intent: expected.intent };
  }
  return {
    status: 'contradiction', intent: auditedIntent,
    reason: `expected ${expected?.kind ?? 'known'} ${expected?.grave ? 'grave' : 'ordinary'} intent`,
  };
}
