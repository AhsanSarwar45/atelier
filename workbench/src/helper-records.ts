/**
 * The conversations of every agent a chat sent off, read back from disk.
 *
 * A helper's turns are not in the chat's own record. The kit writes each one
 * into its own file beside it — `<chat>/subagents/agent-<id>.jsonl`, with an
 * `agent-<id>.meta.json` naming the call that sent it off — and the chat's
 * record keeps only the call and the answer it came back with. So a chat read
 * back from the record had no helpers at all: no rows on its panel, no turns to
 * open, and a card a helper alone touched was nowhere on the chat, because
 * nothing in the file the app opened had ever mentioned it (bw-7ks.22.7).
 *
 * Read once, when the chat is read in. Everything a row needs is in the
 * helper's own file: which model it ran, how long it took, what it spent, how
 * many calls it made and what it answered.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Spend, spentOn } from '../../src/workbench/context-window.ts';
import {
  IMPORTED_MESSAGES,
  type PastEntry,
  pastTranscript,
  textOf,
  toolCallsOf,
} from '../../src/workbench/imported-history.ts';

/** One line of a helper's own record, as much of it as a row needs. */
export interface HelperLine {
  type?: string;
  message?: unknown;
  timestamp?: string;
}

/** What the kit writes beside a helper's record about the work it was given. */
export interface HelperMeta {
  agentType?: unknown;
  description?: unknown;
  toolUseId?: unknown;
}

/** One agent a chat sent off, as its own record has it. */
export interface HelperPast {
  /** The kit's name for this piece of work, which names its file too. */
  agentId: string;
  /** The call in the chat that sent it off; the row and its turns hang off it. */
  toolCallId: string | null;
  /** Which kind of helper was asked for, when the kit says. */
  agentType: string | null;
  /** The brief, in the sender's own words. */
  what: string;
  model: string | null;
  seconds: number;
  tokens: number;
  /** The same spend split the way the kit reports one call, for a chat's total. */
  spend: Spend;
  calls: number;
  /** Its last word, which is what the row shows once it has finished. */
  result: string | null;
  /** Its conversation, in the rows a reader sees. */
  entries: PastEntry[];
  /** When it started, so the panel lists them in the order they went off. */
  at: string;
}

/** The first line of a string, trimmed, for a row that has one line to spend. */
const oneLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? '';

/**
 * One helper's row and conversation, worked out from its own record.
 *
 * The numbers are the record's own arithmetic rather than a figure the kit
 * states anywhere: a running helper's spend arrives on the wire, a finished
 * one's is only ever in what its calls cost. Every call's whole prompt and its
 * answer are added up — words sent, words the cache saved, words written — the
 * same reading of a turn the fullness gauge makes, summed over the turns.
 */
export function helperFrom(agentId: string, meta: HelperMeta, lines: HelperLine[]): HelperPast {
  let model: string | null = null;
  let calls = 0;
  let first = '';
  let last = '';
  let answer = '';
  for (const line of lines) {
    if (typeof line.timestamp === 'string' && line.timestamp) {
      if (!first) first = line.timestamp;
      last = line.timestamp;
    }
    if (line.type !== 'assistant') continue;
    const message = line.message as { model?: unknown } | null;
    if (model === null && typeof message?.model === 'string') model = message.model;
    calls += toolCallsOf(line.message).length;
    const said = textOf(line.message);
    if (said) answer = said;
  }
  const began = Date.parse(first);
  const ended = Date.parse(last);
  const seconds =
    Number.isFinite(began) && Number.isFinite(ended) ? Math.max(0, Math.round((ended - began) / 1000)) : 0;
  const spend = spentOn(lines);
  return {
    agentId,
    toolCallId: typeof meta.toolUseId === 'string' && meta.toolUseId ? meta.toolUseId : null,
    agentType: typeof meta.agentType === 'string' && meta.agentType ? meta.agentType : null,
    what: oneLine(typeof meta.description === 'string' ? meta.description : ''),
    model,
    seconds,
    tokens: spend.total,
    spend,
    calls,
    result: oneLine(answer) || null,
    // The tail of it, on the same terms as the chat's own: a conversation drawn
    // whole is the one thing that makes opening a chat slow, and what the row
    // says about the work is the brief, which is on the row already.
    entries: pastTranscript(lines).slice(-IMPORTED_MESSAGES),
    at: first,
  };
}

/**
 * Every helper a chat sent off, oldest first.
 *
 * `record` is the chat's own file. A chat that sent nothing off has no such
 * directory, which is not a fault and comes back empty. One helper's file being
 * unreadable loses that helper and not the rest: the chat is drawn either way.
 */
export function helpersOf(record: string): HelperPast[] {
  const dir = join(record.replace(/\.jsonl$/, ''), 'subagents');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: HelperPast[] = [];
  for (const name of names) {
    const named = /^agent-(.+)\.jsonl$/.exec(name);
    if (!named) continue;
    const agentId = named[1]!;
    let lines: HelperLine[];
    try {
      lines = readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
          try {
            return JSON.parse(line) as HelperLine;
          } catch {
            return null; // Half a line at the end of a file still being written.
          }
        })
        .filter((line): line is HelperLine => line !== null);
    } catch {
      continue;
    }
    let meta: HelperMeta = {};
    try {
      meta = JSON.parse(readFileSync(join(dir, `agent-${agentId}.meta.json`), 'utf8')) as HelperMeta;
    } catch {
      // No meta means no call to hang it off; the row still says what it spent.
    }
    found.push(helperFrom(agentId, meta, lines));
  }
  return found.sort((a, b) => a.at.localeCompare(b.at));
}
