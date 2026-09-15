/**
 * The search box's words, read the way the server reads them.
 *
 * The box is the query. Every control beside it writes a `key:value` into the
 * text and is drawn from what the text says, so a search typed by hand and one
 * built with the controls are the same search, and either can finish the
 * other. The grammar itself lives on the server (server/src/search/words.rs);
 * this only has to find the words the controls own. Which keys there are is
 * each source's own: its grammar.
 */

export interface Grammar {
  /** Every way a key can be written, to the key it means. `in` aims words at the scopes. */
  keys: Record<string, string>;
  /** The keys offered while a plain word is typed. */
  offered: string[];
  /** The values offered once a key is typed. */
  values: Record<string, string[]>;
}

/** What a key means, or null for a word that only looks like one. */
export function keyOf(grammar: Grammar, written: string): string | null {
  return grammar.keys[written.toLowerCase()] ?? null;
}

export interface Token {
  start: number;
  end: number;
  negated: boolean;
  key: string | null;
  value: string;
}

/** The box split on spaces outside quotes, each piece with where it stands. */
export function tokens(text: string, grammar: Grammar): Token[] {
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
    const key = /^[A-Za-z]+$/.test(written) ? keyOf(grammar, written) : null;
    found.push({ start, end: at, negated, key, value: key ? rest.slice(colon + 1) : rest });
  }
  return found;
}

export interface Controls {
  /** The scopes `in:` names, in the order named. */
  scopes: string[];
  /** Each filter's value, or null when the box names none. */
  filters: Record<string, string | null>;
}

/** What the controls show for the words in the box. */
export function controlsOf(text: string, grammar: Grammar, scopes: string[], filters: string[]): Controls {
  const controls: Controls = { scopes: [], filters: Object.fromEntries(filters.map((key) => [key, null])) };
  for (const token of tokens(text, grammar)) {
    if (token.negated || !token.key) continue;
    if (token.key === 'in') {
      for (const name of token.value.split(',')) {
        const scope = keyOf(grammar, name);
        if (scope && scopes.includes(scope) && !controls.scopes.includes(scope)) controls.scopes.push(scope);
      }
    } else if (filters.includes(token.key)) {
      controls.filters[token.key] ??= token.value;
    }
  }
  return controls;
}

const quoted = (value: string) => (/\s/.test(value) ? `"${value}"` : value);

/**
 * The box with one control's words replaced. The control's words go first, so
 * the word still being typed stays last and is still read as unfinished.
 */
export function withFilter(text: string, grammar: Grammar, key: string, value: string | null): string {
  let rest = '';
  let from = 0;
  for (const token of tokens(text, grammar)) {
    if (!token.negated && token.key === key) {
      rest += text.slice(from, token.start);
      from = token.end;
    }
  }
  rest = (rest + text.slice(from)).replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
  if (!value) return rest;
  return `${key}:${quoted(value)} ${rest}`;
}

export function withScopes(text: string, grammar: Grammar, scopes: string[]): string {
  return withFilter(text, grammar, 'in', scopes.length ? scopes.join(',') : null);
}

export interface Suggestion {
  label: string;
  /** What replaces the word being typed. */
  insert: string;
}

/**
 * What the word being typed could become, and where it stands. A plain word
 * is offered the keys it starts; a key is offered its values.
 */
export function suggestionsFor(text: string, grammar: Grammar): { start: number; end: number; items: Suggestion[] } | null {
  if (!text || /\s$/.test(text)) return null;
  const last = tokens(text, grammar).at(-1);
  if (!last) return null;
  const sign = last.negated ? '-' : '';
  const typed = text.slice(last.start + sign.length, last.end);
  const colon = typed.indexOf(':');
  let items: Suggestion[];
  if (colon < 0) {
    if (!/^[a-z]+$/i.test(typed)) return null;
    items = grammar.offered
      .filter((key) => key.startsWith(typed.toLowerCase()) && key !== typed.toLowerCase())
      .map((key) => ({ label: `${key}:`, insert: `${sign}${key}:` }));
  } else {
    const key = keyOf(grammar, typed.slice(0, colon));
    if (!key) return null;
    const written = typed.slice(0, colon + 1);
    const already = last.value.toLowerCase();
    items = (grammar.values[key] ?? [])
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
