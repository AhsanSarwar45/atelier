/**
 * The executable command inside provider and process transport.
 *
 * Providers do not agree on how they carry a command. Claude hands Bash a
 * string, Codex can wrap the same string in a code-mode tool call, and native
 * command execution may add `/bin/bash -lc`. Remote and container launchers
 * add another process boundary. None of those wrappers says what the work is.
 *
 * This module only removes syntax whose grammar it knows. It never evaluates
 * JavaScript, expands shell values, reads a script, or searches arbitrary tool
 * input for command-looking strings. An uncertain value stays opaque.
 */

export type CommandConfidence = 'schema' | 'parsed' | 'opaque';

export interface CommandBoundary {
  kind: 'shell' | 'remote' | 'container' | 'user' | 'environment' | 'limit' | 'package' | 'proxy';
  via: string;
  target?: string;
}

export interface SemanticCommand {
  /** The command text whose executable and arguments decide categorization. */
  command: string;
  /** Transport peeled on the way in, outside first. */
  boundaries: CommandBoundary[];
  confidence: CommandConfidence;
}

export interface NormalizedCommands {
  raw: unknown;
  commands: SemanticCommand[];
  status: 'complete' | 'partial' | 'opaque';
}

interface Word {
  value: string;
  start: number;
  end: number;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish']);
const MOST_DEPTH = 8;
const MOST_CALLS = 64;

const basename = (value: string): string => value.replace(/\\/g, '/').split('/').pop() ?? value;

/** Render argv without turning spaces or shell operators inside one argument into syntax. */
const shellArg = (value: string): string => {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

/** A bounded POSIX-shell word reader. Operators end the current invocation. */
function shellWords(text: string): Word[] {
  const out: Word[] = [];
  let value = '';
  let start = -1;
  let quote = '';

  const finish = (end: number): void => {
    if (start < 0) return;
    out.push({ value, start, end });
    value = '';
    start = -1;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (!quote && char === '\\' && (text.charAt(i + 1) === '\n' || text.charAt(i + 1) === '\r')) {
      if (text.charAt(i + 1) === '\r' && text.charAt(i + 2) === '\n') i++;
      i++;
      continue;
    }
    if (!quote && (char === ';' || char === '|' || char === '&' || char === '\n')) {
      finish(i);
      break;
    }
    if (!quote && /\s/.test(char)) {
      finish(i);
      continue;
    }
    if (start < 0) start = i;
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (quote && char === quote) {
      quote = '';
      continue;
    }
    if (char === '\\' && quote !== "'" && i + 1 < text.length) {
      value += text.charAt(++i);
      continue;
    }
    value += char;
  }
  finish(text.length);
  return out;
}

const from = (text: string, words: Word[], at: number): string | null => {
  const word = words[at];
  return word ? text.slice(word.start).trim() : null;
};

/** Options known to consume the following argv. */
function afterOptions(words: Word[], at: number, takesValue: ReadonlySet<string>): number {
  while (at < words.length) {
    const word = words[at]!.value;
    if (word === '--') return at + 1;
    if (!word.startsWith('-') || word === '-') return at;
    const ownValue = word.includes('=') || /^-[^-].+/.test(word) && !takesValue.has(word.slice(0, 2));
    if (!ownValue && takesValue.has(word)) at += 2;
    else at += 1;
  }
  return at;
}

const SUDO_VALUE = new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from']);
const SSH_VALUE = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w']);
const DOCKER_GLOBAL_VALUE = new Set(['--config', '--context', '--host', '-H', '--log-level']);
const DOCKER_EXEC_VALUE = new Set(['--detach-keys', '--env', '-e', '--env-file', '--user', '-u', '--workdir', '-w']);
const KUBECTL_GLOBAL_VALUE = new Set(['--context', '--namespace', '-n', '--cluster', '--user', '--kubeconfig', '--request-timeout']);
const KUBECTL_EXEC_VALUE = new Set(['--container', '-c', '--filename', '-f', '--pod-running-timeout']);
const COMPOSE_EXEC_VALUE = new Set(['--detach', '-d', '--env', '-e', '--index', '--privileged', '--user', '-u', '--workdir', '-w']);

/** A shell's own `-c`, before its script/operand; never a later child's flag. */
function shellCommandAt(words: readonly { value: string }[]): number {
  for (let at = 1; at < words.length; at++) {
    const option = words[at]!.value;
    if (option === '--') return -1;
    if (!option.startsWith('-') || option === '-') return -1;
    if (/^-[^-]*c/.test(option)) return at + 1 < words.length ? at + 1 : -1;
    if (['-O', '-o', '--rcfile', '--init-file'].includes(option)) at++;
  }
  return -1;
}

function directInner(text: string, words: Word[]): { command: string; boundary: CommandBoundary } | null {
  if (!words.length) return null;
  // Peeling one process out of a compound outer shell would discard the work
  // after its `;`, `&&`, pipe, or background marker. Compound parsing owns it.
  if (words[words.length - 1]!.end < text.trimEnd().length) return null;
  // Test assignments before basename: `NAME=/path/to/value` contains slashes,
  // but the value is not an executable path.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.value)) {
    let at = 0;
    while (words[at] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!.value)) at++;
    const command = from(text, words, at);
    return command ? { command, boundary: { kind: 'environment', via: 'assignment' } } : null;
  }

  const head = basename(words[0]!.value);

  if (SHELLS.has(head)) {
    const flag = shellCommandAt(words) - 1;
    if (flag < 0 || !words[flag + 1]) return null;
    return { command: words[flag + 1]!.value, boundary: { kind: 'shell', via: head } };
  }

  if (head === 'cmd.exe' || head === 'cmd') {
    const flag = words.findIndex((word, i) => i > 0 && /^\/c$/i.test(word.value));
    const command = flag < 0 ? null : from(text, words, flag + 1);
    return command ? { command, boundary: { kind: 'shell', via: head } } : null;
  }

  if (head === 'powershell' || head === 'powershell.exe' || head === 'pwsh') {
    const flag = words.findIndex((word, i) => i > 0 && /^-(?:command|c)$/i.test(word.value));
    const command = flag < 0 ? null : from(text, words, flag + 1);
    return command ? { command, boundary: { kind: 'shell', via: head } } : null;
  }

  if (head === 'env') {
    let at = 1;
    while (at < words.length) {
      const value = words[at]!.value;
      if (value === '-u' || value === '--unset' || value === '-C' || value === '--chdir') { at += 2; continue; }
      if (value.startsWith('-')) { at++; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) { at++; continue; }
      break;
    }
    const command = from(text, words, at);
    return command ? { command, boundary: { kind: 'environment', via: head } } : null;
  }

  if (head === 'sudo' || head === 'doas') {
    const at = afterOptions(words, 1, head === 'sudo' ? SUDO_VALUE : new Set(['-u', '-C']));
    const command = from(text, words, at);
    return command ? { command, boundary: { kind: 'user', via: head } } : null;
  }

  if (head === 'command' || head === 'exec' || head === 'nohup' || head === 'setsid' || head === 'nice' || head === 'stdbuf') {
    const values = head === 'nice' ? new Set(['-n', '--adjustment'])
      : head === 'stdbuf' ? new Set(['-i', '--input', '-o', '--output', '-e', '--error'])
        : new Set<string>();
    const at = afterOptions(words, 1, values);
    const command = from(text, words, at);
    return command ? { command, boundary: { kind: 'environment', via: head } } : null;
  }

  if (head === 'timeout') {
    let at = afterOptions(words, 1, new Set(['-s', '--signal', '-k', '--kill-after']));
    if (words[at]) at++; // duration
    const command = from(text, words, at);
    return command ? { command, boundary: { kind: 'limit', via: head } } : null;
  }

  if (head === 'ssh') {
    let at = afterOptions(words, 1, SSH_VALUE);
    const target = words[at]?.value;
    if (!target) return null;
    at++;
    if (words[at]?.value === '--') at++;
    const tail = words.slice(at);
    const command = tail.length === 1 ? tail[0]!.value : from(text, words, at);
    return command ? { command, boundary: { kind: 'remote', via: head, target } } : null;
  }

  if (head === 'docker' || head === 'podman') {
    let at = afterOptions(words, 1, DOCKER_GLOBAL_VALUE);
    const operation = words[at]?.value;
    if (operation === 'compose') {
      at = afterOptions(words, at + 1, new Set(['--ansi', '--env-file', '-f', '--file', '--profile', '--project-directory', '-p', '--project-name']));
      if (words[at]?.value !== 'exec') return null;
      at = afterOptions(words, at + 1, COMPOSE_EXEC_VALUE);
    } else {
      if (operation !== 'exec') return null;
      at = afterOptions(words, at + 1, DOCKER_EXEC_VALUE);
    }
    const target = words[at]?.value;
    if (!target) return null;
    at++;
    if (words[at]?.value === '--') at++;
    const command = from(text, words, at);
    return command ? { command, boundary: { kind: 'container', via: operation === 'compose' ? `${head} compose exec` : `${head} exec`, target } } : null;
  }

  if (head === 'kubectl') {
    let at = afterOptions(words, 1, KUBECTL_GLOBAL_VALUE);
    if (words[at]?.value !== 'exec') return null;
    at = afterOptions(words, at + 1, KUBECTL_EXEC_VALUE);
    const target = words[at]?.value;
    if (!target) return null;
    at++;
    while (at < words.length && words[at]!.value !== '--') at++;
    if (words[at]?.value === '--') at++;
    const command = from(text, words, at);
    return command ? { command, boundary: { kind: 'container', via: 'kubectl exec', target } } : null;
  }

  if (head === 'npx' || head === 'bunx') {
    const at = afterOptions(words, 1, new Set(['--package', '-p', '--cache']));
    const command = from(text, words, at);
    return command ? { command, boundary: { kind: 'package', via: head } } : null;
  }
  if ((head === 'pnpm' || head === 'yarn') && words[1]?.value === 'exec') {
    const command = from(text, words, 2);
    return command ? { command, boundary: { kind: 'package', via: `${head} exec` } } : null;
  }
  if (head === 'npm' && words[1]?.value === 'exec') {
    const at = afterOptions(words, 2, new Set(['--package', '-p', '--call', '-c']));
    const command = from(text, words, at);
    return command ? { command, boundary: { kind: 'package', via: 'npm exec' } } : null;
  }
  if (['uv', 'poetry', 'pipenv', 'rye', 'hatch'].includes(head) && words[1]?.value === 'run') {
    const command = from(text, words, 2);
    return command ? { command, boundary: { kind: 'environment', via: `${head} run` } } : null;
  }
  if (head === 'bundle' && words[1]?.value === 'exec') {
    const command = from(text, words, 2);
    return command ? { command, boundary: { kind: 'environment', via: 'bundle exec' } } : null;
  }
  if ((head === 'direnv' || head === 'mise') && words[1]?.value === 'exec') {
    let at = 2;
    if (head === 'direnv' && words[at]) at++; // directory
    if (words[at]?.value === '--') at++;
    const command = from(text, words, at);
    return command ? { command, boundary: { kind: 'environment', via: `${head} exec` } } : null;
  }
  if (head === 'nix' && words[1]?.value === 'develop') {
    const marker = words.findIndex((word, at) => at > 1 && (word.value === '-c' || word.value === '--command'));
    const command = marker < 0 ? null : from(text, words, marker + 1);
    return command ? { command, boundary: { kind: 'environment', via: 'nix develop' } } : null;
  }
  if (head === 'rtk' && words[1]?.value === 'proxy') {
    const command = from(text, words, 2);
    return command ? { command, boundary: { kind: 'proxy', via: 'rtk proxy' } } : null;
  }
  return null;
}

function peel(text: string, inherited: CommandBoundary[] = []): SemanticCommand {
  let command = text.trim();
  const boundaries = [...inherited];
  for (let depth = 0; depth < MOST_DEPTH; depth++) {
    const inner = directInner(command, shellWords(command));
    if (!inner || inner.command.trim() === command) {
      return { command, boundaries, confidence: boundaries.length ? 'parsed' : 'schema' };
    }
    boundaries.push(inner.boundary);
    command = inner.command.trim();
  }
  return { command, boundaries, confidence: 'opaque' };
}

/** Decode a static JavaScript string. Expressions in template strings are opaque. */
function jsString(text: string, at: number): { value: string; end: number } | null {
  const quote = text.charAt(at);
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let value = '';
  for (let i = at + 1; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === quote) return { value, end: i + 1 };
    if (quote === '`' && char === '$' && text.charAt(i + 1) === '{') return null;
    if (char !== '\\') { value += char; continue; }
    const next = text.charAt(++i);
    if (!next) return null;
    if (next === 'n') value += '\n';
    else if (next === 'r') value += '\r';
    else if (next === 't') value += '\t';
    else value += next;
  }
  return null;
}

/** End of a balanced call, skipping strings and comments. */
function callEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === '"' || char === "'" || char === '`') {
      const held = jsString(text, i);
      if (!held) return -1;
      i = held.end - 1;
      continue;
    }
    if (char === '/' && text.charAt(i + 1) === '/') {
      i = text.indexOf('\n', i + 2);
      if (i < 0) return -1;
      continue;
    }
    if (char === '/' && text.charAt(i + 1) === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/** A static string property inside one already-bounded call. */
function property(call: string, names: readonly string[]): string | null {
  for (const name of names) {
    const found = new RegExp(`(?:\\b${name}|["']${name}["'])\\s*:\\s*`, 'g').exec(call);
    if (!found) continue;
    const held = jsString(call, found.index + found[0].length);
    if (held) return held.value;
  }
  return null;
}

/**
 * Static command calls inside a Codex code-mode envelope.
 *
 * Matches are accepted only outside JavaScript strings/comments and only from
 * the declared command-call names. This prevents source text, regexes, and
 * arbitrary object properties from being promoted to executable commands.
 */
export function commandsInCodeMode(text: string): string[] {
  const names = ['tools.exec_command', 'tools.exec', 'functions.exec_command', 'exec_command'];
  const commands: string[] = [];
  for (let i = 0; i < text.length && commands.length < MOST_CALLS;) {
    const char = text.charAt(i);
    if (char === '"' || char === "'" || char === '`') {
      const held = jsString(text, i);
      if (!held) break;
      i = held.end;
      continue;
    }
    if (char === '/' && text.charAt(i + 1) === '/') {
      const end = text.indexOf('\n', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (char === '/' && text.charAt(i + 1) === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    const name = names.find((candidate) => text.startsWith(candidate, i));
    if (!name) { i++; continue; }
    const before = text.charAt(i - 1);
    const after = text.charAt(i + name.length);
    if ((before && /[\w$.]/.test(before)) || (after && /[\w$]/.test(after))) { i += name.length; continue; }
    let open = i + name.length;
    while (/\s/.test(text.charAt(open))) open++;
    if (text.charAt(open) !== '(') { i += name.length; continue; }
    const end = callEnd(text, open);
    if (end < 0) break;
    const command = property(text.slice(open + 1, end - 1), ['cmd', 'command']);
    if (command !== null) commands.push(command);
    i = end;
  }
  return commands;
}

/** Normalize one known command payload. Unknown/dynamic payloads stay opaque. */
export function normalizeCommands(raw: string | readonly string[], source: 'direct' | 'code-mode' = 'direct'): NormalizedCommands {
  if (Array.isArray(raw)) {
    if (!raw.length || raw.some((part) => typeof part !== 'string')) return { raw, commands: [], status: 'opaque' };
    const command = raw.map(shellArg).join(' ');
    const head = basename(raw[0]!);
    if (SHELLS.has(head)) {
      const flag = shellCommandAt(raw.map((value) => ({ value }))) - 1;
      if (flag >= 0 && raw[flag + 1]) {
        const semantic = peel(raw[flag + 1]!, [{ kind: 'shell', via: head }]);
        return { raw, commands: [semantic], status: semantic.confidence === 'opaque' ? 'partial' : 'complete' };
      }
    }
    return { raw, commands: [{ command, boundaries: [], confidence: 'schema' }], status: 'complete' };
  }

  const text = String(raw).trim();
  if (!text) return { raw, commands: [], status: 'opaque' };
  const candidates = source === 'code-mode' ? commandsInCodeMode(text) : [text];
  if (!candidates.length) return { raw, commands: [], status: 'opaque' };
  const commands = candidates.map((command) => peel(command));
  return {
    raw,
    commands,
    status: commands.some((command) => command.confidence === 'opaque') ? 'partial' : 'complete',
  };
}

/** Whether a string is an observed, statically decodable provider envelope. */
export const isCodeModeEnvelope = (text: string): boolean =>
  /\b(?:tools\.(?:exec_command|exec)|functions\.exec_command|exec_command)\s*\(/.test(text);
