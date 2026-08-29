/** Privacy-safe structure of compound shell input. No argument, path, pattern,
 * source line, URL, identifier, or here-document body leaves this module. */

export interface CommandStructure {
  compound: boolean;
  profile: string;
  stages: string[];
  heredocs: number;
}

interface MaskedShell {
  visible: string;
  heredocs: number;
  documents: HereDocument[];
}

export interface HereDocument {
  body: string;
  delimiter: string;
}

export function hereDocumentOpeners(text: string): Array<{ delimiter: string; stripTabs: boolean }> {
  const found: Array<{ delimiter: string; stripTabs: boolean }> = [];
  const pattern = /(?<!<)<<(-)?(?!<)\s*(?:(['"])([^'"\r\n]+)\2|\\?([^\s;&|<>]+))/g;
  for (const match of text.matchAll(pattern)) {
    const delimiter = match[3] ?? match[4] ?? '';
    if (delimiter) found.push({ delimiter, stripTabs: match[1] === '-' });
  }
  return found;
}

/** Hide here-document bodies while retaining the command that consumes each
 * body and every command before and after it. A body is data/code belonging to
 * that one launcher; it is not top-level shell syntax. */
export function maskHereDocuments(command: string): MaskedShell {
  const lines = command.split(/(?<=\n)/);
  const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
  let active: { delimiter: string; stripTabs: boolean } | undefined;
  let visible = '';
  let heredocs = 0;
  const documents: HereDocument[] = [];
  let body: string[] = [];

  for (const line of lines) {
    const withoutNewline = line.replace(/\r?\n$/, '');
    if (active) {
      const candidate = active.stripTabs ? withoutNewline.replace(/^\t+/, '') : withoutNewline;
      visible += line.endsWith('\n') ? '\n' : '';
      if (candidate === active.delimiter) {
        documents.push({ body: body.join(''), delimiter: active.delimiter });
        body = [];
        active = pending.shift();
      } else body.push(line);
      continue;
    }

    visible += line;
    for (const opener of hereDocumentOpeners(line)) {
      pending.push(opener);
      heredocs += 1;
    }
    active = pending.shift();
  }
  // A truncated stored call can end before its delimiter. Its body still
  // belongs to the launcher and must not leak back into top-level shell text.
  if (active) documents.push({ body: body.join(''), delimiter: active.delimiter });
  return { visible, heredocs, documents };
}

interface Link { text: string; piped: boolean }

function links(command: string): Link[] {
  const out: Link[] = [];
  let start = 0;
  let quote = '';
  let piped = false;
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at]!;
    if (quote) {
      if (char === '\\' && quote === '"') at += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '\\') { at += 1; continue; }
    if (char === ';' || char === '\n' || char === '|' || (char === '&' && command[at + 1] === '&')) {
      out.push({ text: command.slice(start, at), piped });
      const doubled = (char === '|' || char === '&') && command[at + 1] === char;
      piped = char === '|' && !doubled;
      if (doubled) at += 1;
      start = at + 1;
    }
  }
  out.push({ text: command.slice(start), piped });
  return out;
}

/** Top-level executable links with heredoc bodies removed. Intended for
 * in-process auditing only: callers must never persist the returned text. */
export function topLevelShellCommands(command: string): Link[] {
  const masked = maskHereDocuments(command);
  const syntax = shellSyntax(masked.visible);
  if (/^\s*(?:for|while|until|if|function)\s|;\s*(?:do|then)\s|\n\s*(?:do|then)\s/.test(syntax)) return [];
  return links(masked.visible).filter((link) => link.text.trim());
}

function words(text: string): string[] {
  const out: string[] = [];
  let word = '';
  let quote = '';
  let began = false;
  const push = () => { if (began) out.push(word); word = ''; began = false; };
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (quote) {
      if (char === '\\' && quote === '"' && at + 1 < text.length) word += text[++at]!;
      else if (char === quote) quote = '';
      else word += char;
      began = true;
    } else if (char === "'" || char === '"') {
      quote = char; began = true;
    } else if (char === '\\' && at + 1 < text.length) {
      const escaped = text[++at]!;
      if (escaped !== '\n' && escaped !== '\r') { word += escaped; began = true; }
    } else if (/\s/.test(char)) push();
    else { word += char; began = true; }
  }
  push();
  return out;
}

function shellSyntax(command: string): string {
  let quote = '';
  let syntax = '';
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at]!;
    if (quote) {
      if (char === '\\' && quote === '"') at += 1;
      else if (char === quote) quote = '';
      syntax += ' ';
    } else if (char === "'" || char === '"') {
      quote = char;
      syntax += ' ';
    } else if (char === '\\') {
      syntax += '  ';
      at += 1;
    } else syntax += char;
  }
  return syntax;
}

const OMIT = new Set(['', 'cd', 'echo', 'printf', 'export', 'set', 'true', 'false', 'env', 'pwd', 'source', '.', ':']);
const TRIM = new Set(['head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'jq', 'column', 'tee', 'less', 'more', 'nl', 'rev', 'tac', 'awk', 'sed', 'grep', 'rg']);
const KNOWN = new Set([
  'awk', 'bash', 'bd', 'bun', 'cargo', 'cat', 'chmod', 'chown', 'claude', 'codex', 'cp', 'curl',
  'deno', 'docker', 'find', 'git', 'go', 'grep', 'head', 'job', 'jq', 'kill', 'kubectl', 'land',
  'ln', 'ls', 'make', 'mkdir', 'mv', 'next', 'node', 'npm', 'npx', 'perl', 'php', 'playwright',
  'pnpm', 'ps', 'psql', 'pytest', 'python', 'python3', 'rg', 'rm', 'rsync', 'ruby', 'sed', 'sh',
  'sleep', 'sqlite3', 'ssh', 'stat', 'systemctl', 'tail', 'tar', 'tee', 'test', 'touch', 'tsc',
  'tsx', 'vite', 'vitest', 'wc', 'wget', 'yarn', 'zsh',
]);
const WRAPPERS = new Set(['sudo', 'time', 'setsid', 'nohup', 'command', 'exec', 'xargs', 'rtk', 'timeout', 'nice', 'ionice']);

const base = (word: string) => word.slice(word.lastIndexOf('/') + 1).toLowerCase();

function stageOf(link: Link): string | null {
  let argv = words(link.text).filter((word) => !/^[0-9]*[<>]/.test(word));
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) argv = argv.slice(1);
  for (let pass = 0; pass < 4 && argv.length && WRAPPERS.has(base(argv[0]!)); pass += 1) {
    const wrapper = base(argv[0]!);
    argv = argv.slice(wrapper === 'timeout' || wrapper === 'nice' || wrapper === 'ionice' ? 2 : 1);
    if (wrapper === 'rtk' && argv[0] === 'proxy') argv = argv.slice(1);
    while (argv[0]?.startsWith('-')) argv = argv.slice(1);
  }
  const head = base(argv[0] ?? '');
  if (OMIT.has(head) || (link.piped && TRIM.has(head))) return null;
  if (/^\s*(?:if|for|while|until|function)\b/.test(link.text)) return 'shell-script';
  const safe = KNOWN.has(head) ? head : /\.(?:py|js|mjs|ts|tsx|sh)$/.test(head) ? 'script' : 'other';
  if (link.text.includes('<<')) {
    if (safe === 'python' || safe === 'python3') return 'python-heredoc';
    if (safe === 'node' || safe === 'deno' || safe === 'bun') return 'javascript-heredoc';
    if (safe === 'sh' || safe === 'bash' || safe === 'zsh') return 'shell-heredoc';
    if (safe === 'cat' || safe === 'tee') return 'data-heredoc';
    return `${safe}-heredoc`;
  }
  if ((safe === 'python' || safe === 'python3') && argv.some((word, at) => word === '-m' && argv[at + 1] === 'pytest')) return 'pytest';
  return safe;
}

export function commandStructure(command: string): CommandStructure {
  const masked = maskHereDocuments(command);
  const syntax = shellSyntax(masked.visible);
  const control = /^\s*(?:for|while|until|if|function)\s|;\s*(?:do|then)\s|\n\s*(?:do|then)\s/.test(syntax);
  if (control) {
    const suffix = masked.heredocs ? '+heredoc' : '';
    return {
      compound: true,
      profile: `control-script${suffix}`,
      stages: ['control-script'],
      heredocs: masked.heredocs,
    };
  }
  const split = links(masked.visible);
  const stages = split.map(stageOf).filter((stage): stage is string => Boolean(stage));
  const compound = stages.length > 1 || masked.heredocs > 0;
  const profile = stages.join('>') || (masked.heredocs ? 'anonymous-heredoc' : '');
  return { compound, profile, stages, heredocs: masked.heredocs };
}
