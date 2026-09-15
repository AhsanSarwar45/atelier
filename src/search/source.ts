/**
 * What a source of search results gives the shared search (bw-21a2.6).
 *
 * The chats, the board and the files are searched the same way and look the
 * same: a box that is the query, controls that write into it, a list of
 * matches each with the places in it that matched, and an agent to ask in
 * plain words. What differs is supplied here: the keys, how a page is found,
 * how each match and each place in it is drawn, and where opening one goes.
 */
import type { ReactNode } from 'react';

import type { Grammar } from '@/search/syntax';

export interface Segment {
  text: string;
  mark?: boolean;
}

export interface Choice {
  value: string;
  label: string;
}

/** A menu that writes one key. */
export interface FilterSpec {
  key: string;
  label: string;
  choices: Choice[];
}

export type DataAttributes = Record<`data-${string}`, string>;

/** One row that Enter or a click opens. */
export interface Place {
  key: string;
  testId: string;
  attrs?: DataAttributes;
  className?: string;
  body: ReactNode;
  open: () => void;
}

/** One match: its own row, then the places in it that matched. */
export interface Group {
  key: string;
  testId: string;
  attrs?: DataAttributes;
  head: Place;
  places: Place[];
}

export interface Page<Item> {
  items: Item[];
  next: number | null;
}

export interface WordsSearch<Item> {
  /** What is searched, said to a screen reader: "Search every conversation". */
  label: string;
  placeholder: string;
  /** Said when nothing matched: "No chats." */
  nothing: string;
  grammar: Grammar;
  /** The parts `in:` can aim words at. */
  scopes: Choice[];
  filters: FilterSpec[];
  /** Keys offered on an empty box. */
  starters: string[];
  /** The orders offered, the first the default; none for a source with one order. */
  sorts: Choice[];
  find: (q: string, sort: string, cursor: number) => Promise<Page<Item>>;
  groups: (items: Item[]) => Group[];
}

/** One thing an agent found, with why, and where in it when it said. */
export interface Found {
  reason: string;
  at: string | null;
  [field: string]: unknown;
}

export interface AskSearch<Thing extends Found = Found> {
  label: string;
  placeholder: string;
  nothing: string;
  /** Where the question is posted; it answers with one JSON event per line. */
  url: string;
  /** Anything else the source's ask needs beside the question. */
  body?: Record<string, unknown>;
  /** The found thing's row. The reason is drawn under it. */
  row: (found: Thing) => Place;
}

export interface SearchSource<Item, Thing extends Found = Found> {
  words: WordsSearch<Item>;
  ask: AskSearch<Thing>;
}
