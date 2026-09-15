/**
 * The search box's words, read the way the server reads them.
 *
 * The box is the query. Every control beside it — the parts of a chat to look
 * in, the project, the provider, the dates — writes a `key:value` into the
 * text and is drawn from what the text says, so a search typed by hand and one
 * built with the controls are the same search, and either can finish the
 * other. The grammar itself lives on the server (search_query.rs); this only
 * has to find the words the controls own.
 */

export type Scope = 'title' | 'me' | 'agent' | 'tool';

export const SCOPES: { value: Scope; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'me', label: 'Me' },
  { value: 'agent', label: 'Agent' },
  { value: 'tool', label: 'Tools' },
];

/** The keys a control owns, one each. */
export type Filter = 'in' | 'project' | 'provider' | 'from' | 'after';

const KEYS: Record<string, string> = {
  title: 'title', name: 'title',
  me: 'me', i: 'me', user: 'me', you: 'me',
  agent: 'agent', ai: 'agent', assistant: 'agent', reply: 'agent',
  tool: 'tool', tools: 'tool', cmd: 'tool', command: 'tool', file: 'tool', path: 'tool',
  in: 'in',
  project: 'project', proj: 'project', repo: 'project',
  provider: 'provider', brand: 'provider', with: 'provider',
  card: 'card', bead: 'card', ticket: 'card', issue: 'card',
  from: 'from', origin: 'from', started: 'from',
  after: 'after', since: 'after',
  before: 'before', until: 'before',
  on: 'on', during: 'on',
};

/** What a key means, or null for a word that only looks like one. */
export function keyOf(written: string): string | null {
  return KEYS[written.toLowerCase()] ?? null;
}

export interface Token {
  start: number;
  end: number;
  negated: boolean;
  key: string | null;
  value: string;
}

/** The box split on spaces outside quotes, each piece with where it stands. */
export function tokens(text: string): Token[] {
  const found: Token[] = [];
  let at = 0;
  while (at < text.length) {
    while (at < text.length && /\s/.test(text[at]!)) at += 1;
    if (at >= text.length) break;
    const start = at;
    let inQuotes = false;
    let raw = '';
    while (at < text.length && (inQuotes || !/\s/.test(text[at]!))) {
      if (text[at] === '"') inQuotes = !inQuotes;
      else raw += text[at];
      at += 1;
    }
    const negated = raw.length > 1 && raw.startsWith('-');
    const rest = negated ? raw.slice(1) : raw;
    const colon = rest.indexOf(':');
    const written = colon > 0 ? rest.slice(0, colon) : '';
    const key = /^[A-Za-z]+$/.test(written) ? keyOf(written) : null;
    found.push({ start, end: at, negated, key, value: key ? rest.slice(colon + 1) : rest });
  }
  return found;
}

export interface Controls {
  scopes: Scope[];
  project: string | null;
  provider: string | null;
  from: string | null;
  after: string | null;
}

/** What the controls show for the words in the box. */
export function controlsOf(text: string): Controls {
  const controls: Controls = { scopes: [], project: null, provider: null, from: null, after: null };
  for (const token of tokens(text)) {
    if (token.negated || !token.key) continue;
    if (token.key === 'in') {
      for (const name of token.value.split(',')) {
        const scope = keyOf(name) as Scope | null;
        if (scope && SCOPES.some((s) => s.value === scope) && !controls.scopes.includes(scope)) {
          controls.scopes.push(scope);
        }
      }
    } else if (token.key === 'project' || token.key === 'provider' || token.key === 'from' || token.key === 'after') {
      controls[token.key] ??= token.value;
    }
  }
  return controls;
}

const quoted = (value: string) => (/\s/.test(value) ? `"${value}"` : value);

/**
 * The box with one control's words replaced. The control's words go first, so
 * the word still being typed stays last and is still read as unfinished.
 */
export function withFilter(text: string, key: Filter, value: string | null): string {
  let rest = '';
  let from = 0;
  for (const token of tokens(text)) {
    if (!token.negated && token.key === key) {
      rest += text.slice(from, token.start);
      from = token.end;
    }
  }
  rest = (rest + text.slice(from)).replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
  if (!value) return rest;
  return `${key}:${quoted(value)} ${rest}`;
}

export function withScopes(text: string, scopes: Scope[]): string {
  return withFilter(text, 'in', scopes.length ? scopes.join(',') : null);
}

export interface Suggestion {
  label: string;
  /** What replaces the word being typed. */
  insert: string;
}

const VALUES: Record<string, string[]> = {
  in: SCOPES.map((s) => s.value),
  provider: ['claude', 'codex', 'local'],
  from: ['app', 'terminal'],
  after: ['today', 'yesterday', '7d', '30d', '1y'],
  before: ['today', 'yesterday', '7d', '30d', '1y'],
  on: ['today', 'yesterday'],
};

const OFFERED_KEYS = ['title', 'me', 'agent', 'tool', 'in', 'project', 'provider', 'card', 'from', 'after', 'before', 'on'];

/**
 * What the word being typed could become, and where it stands. A plain word
 * is offered the keys it starts; a key is offered its values.
 */
export function suggestionsFor(
  text: string,
  projects: string[],
): { start: number; end: number; items: Suggestion[] } | null {
  if (!text || /\s$/.test(text)) return null;
  const last = tokens(text).at(-1);
  if (!last) return null;
  const sign = last.negated ? '-' : '';
  const typed = text.slice(last.start + sign.length, last.end);
  const colon = typed.indexOf(':');
  let items: Suggestion[];
  if (colon < 0) {
    if (!/^[a-z]+$/i.test(typed)) return null;
    items = OFFERED_KEYS.filter((key) => key.startsWith(typed.toLowerCase()) && key !== typed.toLowerCase())
      .map((key) => ({ label: `${key}:`, insert: `${sign}${key}:` }));
  } else {
    const key = keyOf(typed.slice(0, colon));
    if (!key) return null;
    const written = typed.slice(0, colon + 1);
    const already = last.value.toLowerCase();
    const offered = key === 'project' ? projects : (VALUES[key] ?? []);
    items = offered
      .filter((value) => value.toLowerCase().startsWith(already) && value.toLowerCase() !== already)
      .slice(0, 8)
      .map((value) => ({ label: value, insert: `${sign}${written}${quoted(value)}` }));
  }
  return items.length ? { start: last.start, end: last.end, items } : null;
}

/** The box with a suggestion taken. A finished value ends the word. */
export function taking(text: string, at: { start: number; end: number }, suggestion: Suggestion): string {
  const tail = suggestion.insert.endsWith(':') ? '' : ' ';
  return text.slice(0, at.start) + suggestion.insert + tail + text.slice(at.end);
}
