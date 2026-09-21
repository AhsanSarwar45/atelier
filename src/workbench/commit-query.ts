/**
 * What a person typed into the commits search box, read as a query
 * (bw-g6zy.4).
 *
 * One box, not six. A rail this narrow has no room for a row of controls per
 * thing that can be filtered, and a search that is half in a box and half in a
 * popover has two states to keep in step and two places to look when the
 * answer is wrong. So the text is the whole of the query: the popover writes
 * qualifiers into it, the chips below it take them out again, and everything
 * a filter knows is on the one line a person can read, edit and paste.
 *
 * The spelling is the one people already know from every forge search box:
 *
 *     fix toast author:ahsan since:"2 weeks ago" path:src/workbench
 *
 * A word with no qualifier searches the message. A qualifier this file does
 * not know — `http://x`, or a colon somebody typed by accident — is left as
 * part of the message rather than swallowed, because refusing to search for
 * the thing that was typed is worse than searching for a little too much.
 */

import type { GitLogQuery } from '@/lib/api';

/** The names a `name:value` token may carry. */
export const QUALIFIERS = ['author', 'sha', 'path', 'since', 'until', 'ref'] as const;

export type Qualifier = (typeof QUALIFIERS)[number];

/** What a typed line means. */
export interface CommitQuery {
  /** The bare words, which search the message. */
  text: string;
  author?: string;
  sha?: string;
  path?: string;
  since?: string;
  until?: string;
  ref?: string;
}

/** The word each qualifier is drawn under on its chip. */
export const QUALIFIER_WORDS: Record<Qualifier, string> = {
  author: 'Author',
  sha: 'Commit',
  path: 'Path',
  since: 'Since',
  until: 'Until',
  ref: 'Branch',
};

/**
 * A name that could be a commit: hex, and long enough to mean one.
 *
 * Seven is git's own abbreviation and the shortest thing anyone pastes. Four
 * would have been enough for git to resolve and far too little to guess from:
 * `added`, `face` and `decade` are all hex, and a person searching for the
 * word added does not want the search quietly widened to a commit.
 */
const LOOKS_LIKE_A_NAME = /^[0-9a-f]{7,40}$/i;

function known(name: string): name is Qualifier {
  return (QUALIFIERS as readonly string[]).includes(name);
}

/**
 * Split a line into its words, keeping anything inside double quotes together.
 *
 * A date is the reason: `since:2 weeks ago` is three words to a splitter and
 * one answer to git, and `since:"2 weeks ago"` is how a person says so. An
 * unclosed quote runs to the end of the line, which is what it looks like it
 * should do while it is still being typed.
 */
export function words(line: string): string[] {
  const found: string[] = [];
  let word = '';
  let quoted = false;
  for (const letter of line) {
    if (letter === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(letter)) {
      if (word) found.push(word);
      word = '';
      continue;
    }
    word += letter;
  }
  if (word) found.push(word);
  return found;
}

/** Read a typed line as a query. */
export function readQuery(line: string): CommitQuery {
  const query: CommitQuery = { text: '' };
  const plain: string[] = [];

  for (const word of words(line)) {
    const colon = word.indexOf(':');
    const name = colon > 0 ? word.slice(0, colon).toLowerCase() : '';
    const value = colon > 0 ? word.slice(colon + 1) : '';
    if (known(name) && value) {
      query[name] = value;
      continue;
    }
    plain.push(word);
  }

  query.text = plain.join(' ');
  return query;
}

/** Spell one value the way it would have to be typed to read back the same. */
function spelled(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** Write a query back out as the line that reads as it. */
export function writeQuery(query: CommitQuery): string {
  const parts = query.text.trim() ? [query.text.trim()] : [];
  for (const name of QUALIFIERS) {
    const value = query[name]?.trim();
    if (value) parts.push(`${name}:${spelled(value)}`);
  }
  return parts.join(' ');
}

/**
 * The same line with one qualifier set, replaced or taken out.
 *
 * This is what the popover and the chips both go through, so a filter can
 * never end up set in one place and not the other.
 */
export function withQualifier(line: string, name: Qualifier, value: string | undefined): string {
  const query = readQuery(line);
  const wanted = value?.trim();
  if (wanted) {
    query[name] = wanted;
  } else {
    delete query[name];
  }
  return writeQuery(query);
}

/** Every filter currently set, in the order they are drawn. */
export function setFilters(query: CommitQuery): { name: Qualifier; word: string; value: string }[] {
  return QUALIFIERS.filter((name) => query[name]?.trim()).map((name) => ({
    name,
    word: QUALIFIER_WORDS[name],
    value: query[name] as string,
  }));
}

/** Whether anything at all is being asked for. */
export function isEmpty(query: CommitQuery): boolean {
  return !query.text.trim() && setFilters(query).length === 0;
}

/**
 * The query as the server takes it.
 *
 * Bare words that are themselves a commit's name are sent as both: `--grep`
 * never matches a name, so a person who pastes one out of a terminal and is
 * shown an empty list has been told the commit is not there when it is. The
 * server looks the name up beside the words rather than instead of them, so
 * asking for both costs nothing when the words match something too.
 */
export function asLogQuery(query: CommitQuery, limit: number, skip = 0): GitLogQuery {
  const text = query.text.trim();
  return {
    limit,
    skip,
    grep: text || undefined,
    author: query.author,
    since: query.since,
    until: query.until,
    sha: query.sha ?? (LOOKS_LIKE_A_NAME.test(text) ? text : undefined),
    file: query.path,
    ref: query.ref,
  };
}
