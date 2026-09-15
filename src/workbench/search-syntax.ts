/**
 * A chat search's keys: the parts of a chat to look in, the project, the
 * provider, where it was begun and the dates. How the box is read is shared
 * with every search (src/search/syntax.ts); this is only what a chat's words
 * are (server/src/workbench/search_query.rs).
 */
import * as words from '@/search/syntax';

export type { Suggestion, Token } from '@/search/syntax';
export { taking } from '@/search/syntax';

export type Scope = 'title' | 'me' | 'agent' | 'tool';

export const SCOPES: { value: Scope; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'me', label: 'Me' },
  { value: 'agent', label: 'Agent' },
  { value: 'tool', label: 'Tools' },
];

/** The keys a control owns, one each. */
export type Filter = 'in' | 'project' | 'provider' | 'from' | 'after';

const FILTERS = ['project', 'provider', 'from', 'after'] as const;

export const CHAT_GRAMMAR: words.Grammar = {
  keys: {
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
  },
  offered: ['title', 'me', 'agent', 'tool', 'in', 'project', 'provider', 'card', 'from', 'after', 'before', 'on'],
  values: {
    in: SCOPES.map((s) => s.value),
    provider: ['claude', 'codex', 'local'],
    from: ['app', 'terminal'],
    after: ['today', 'yesterday', '7d', '30d', '1y'],
    before: ['today', 'yesterday', '7d', '30d', '1y'],
    on: ['today', 'yesterday'],
  },
};

/** What a key means, or null for a word that only looks like one. */
export const keyOf = (written: string) => words.keyOf(CHAT_GRAMMAR, written);

/** The box split on spaces outside quotes, each piece with where it stands. */
export const tokens = (text: string) => words.tokens(text, CHAT_GRAMMAR);

export interface Controls {
  scopes: Scope[];
  project: string | null;
  provider: string | null;
  from: string | null;
  after: string | null;
}

/** What the controls show for the words in the box. */
export function controlsOf(text: string): Controls {
  const read = words.controlsOf(text, CHAT_GRAMMAR, SCOPES.map((s) => s.value), [...FILTERS]);
  return {
    scopes: read.scopes as Scope[],
    project: read.filters.project ?? null,
    provider: read.filters.provider ?? null,
    from: read.filters.from ?? null,
    after: read.filters.after ?? null,
  };
}

export const withFilter = (text: string, key: Filter, value: string | null) =>
  words.withFilter(text, CHAT_GRAMMAR, key, value);

export const withScopes = (text: string, scopes: Scope[]) => words.withScopes(text, CHAT_GRAMMAR, scopes);

/** What the word being typed could become; `projects` are offered after `project:`. */
export const suggestionsFor = (text: string, projects: string[]) =>
  words.suggestionsFor(text, { ...CHAT_GRAMMAR, values: { ...CHAT_GRAMMAR.values, project: projects } });
