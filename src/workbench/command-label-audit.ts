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

export type ExplicitIntent = 'help' | 'version' | 'dry-run' | 'destructive';

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

function invocation(command: string): { head: string; argv: string[] } | null {
  const words = simpleWords(command);
  if (!words?.length) return null;
  let at = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '')) at += 1;
  if (at >= words.length) return null;
  const argv = words.slice(at);
  return { head: base(argv[0]!.replace(/^\0/, '')), argv };
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
  if (args.includes('--dry-run') || args.includes('--dry')) return 'dry-run';

  if (['rm', 'rmdir', 'shred', 'mkfs', 'truncate', 'pkill', 'killall'].includes(head)) return 'destructive';
  if (head === 'kill' && !args.includes('-0')) return 'destructive';
  if (head === 'find' && args.includes('-delete')) return 'destructive';
  if (head === 'git') {
    const sub = args.find((arg) => !arg.startsWith('-')) ?? '';
    if (sub === 'rm' || sub === 'clean') return 'destructive';
    if (sub === 'reset' && args.includes('--hard')) return 'destructive';
    if (sub === 'push' && args.some((arg) => arg === '-f' || arg === '--force' || arg === '--force-with-lease')) return 'destructive';
  }
  if (head === 'docker' && (args[0] === 'rm' || args[0] === 'rmi' || (args[0] === 'system' && args[1] === 'prune'))) {
    return 'destructive';
  }
  if (head === 'kubectl' && args[0] === 'delete') return 'destructive';
  return null;
}

/** Judge only what the independent invocation evidence can settle. */
export function auditCommandLabel(command: string, ran: Ran | null): CommandLabelVerdict {
  const intent = explicitCommandIntent(command);
  if (!ran) return { status: 'uncovered', intent };
  if (!intent) return { status: 'unverified' };

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
  if (ran.grave && ran.kind === 'grave' && SAYS_DESTRUCTION.test(ran.said)) return { status: 'verified', intent };
  return { status: 'contradiction', intent, reason: 'destructive invocation is not labelled as destructive' };
}
