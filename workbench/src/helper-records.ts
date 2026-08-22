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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { answerOwed } from '../../src/workbench/chat-state.ts';
import { type Split, spendIn } from '../../src/workbench/token-picture.ts';
import {
  type PastEntry,
  pastTranscript,
  textOf,
  toolCallsOf,
} from '../../src/workbench/imported-history.ts';
import { lastSaidSync } from './record-tail.ts';

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
  spend: Split;
  calls: number;
  /** Its last word, which is what the row shows once it has finished. */
  result: string | null;
  /** Its whole conversation, in the rows a reader sees, oldest first. */
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
  const spend = spendIn(lines);
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
    // Whole, and cut down by whoever draws it. A first reading shows the tail of
    // it — a conversation drawn whole is the one thing that makes opening a chat
    // slow — but a reader watching one arrive is handed the turns it has not
    // seen, and that count only means anything against the whole (bw-7ks.22.19).
    entries: pastTranscript(lines),
    at: first,
  };
}

/** Where the kit files the conversations of the agents one chat sent off. */
const sentOffDir = (record: string): string => join(record.replace(/\.jsonl$/, ''), 'subagents');

/**
 * Every agent a chat has sent off as the files stand this instant, and how many
 * bytes each one has written.
 *
 * A directory listing and one stat each, no file read. It is asked on every
 * beat of the follower, of every chat somebody is reading — so a chat whose
 * agents have said nothing new since the last look has to cost about nothing
 * (bw-7ks.22.19). The size is what says whether one has.
 */
export function helpersNow(record: string): Map<string, number> {
  const dir = sentOffDir(record);
  const sizes = new Map<string, number>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return sizes; // A chat that has sent nothing off has no such directory.
  }
  for (const name of names) {
    const named = /^agent-(.+)\.jsonl$/.exec(name);
    if (!named) continue;
    try {
      sizes.set(named[1]!, statSync(join(dir, name)).size);
    } catch {
      // Taken away between the listing and the stat: it is not there to draw.
    }
  }
  return sizes;
}

/**
 * How long a helper's own file may have been quiet and still be counted as
 * working.
 *
 * Its last line is asked as well, and the two guards catch different failures.
 * The line says whether the helper's work was finished: 1,516 of the 1,645
 * helper records on this machine end on the plain answer they came back with,
 * which is the helper done. The other 129 end mid-work — a tool call never
 * answered, a thought never followed — because the session they belonged to was
 * killed under them, and those files would read as working for ever.
 *
 * So a quiet bound as well, and this is where it comes from: over 203,342 gaps
 * between one line of a helper and its next, the median is 1.1 seconds and the
 * 99th is 62. Two minutes keeps all but a few thousandths of the real pauses and
 * holds a killed helper's ghost to two minutes (measured 2026-08-22).
 */
export const HELPER_QUIET_MS = 120_000;

/**
 * How many of a chat's helpers are still working, and when the oldest went off.
 *
 * The one thing a chat's own record cannot say. A helper is sent off and the
 * record keeps the call and, once it comes back, the answer — and in between,
 * for the whole of the work, nothing: 1,344 of the 1,445 dispatches on this
 * machine were answered within two seconds and left the helper running detached.
 * A chat whose own turn had ended with three of them still grinding drew Idle.
 *
 * A directory listing and one stat each, then the last 16KB of only those files
 * that have moved lately — so a chat whose helpers are all long finished costs a
 * listing and nothing more. Nothing is remembered between calls: a file that is
 * still moving is a file whose answer cannot be cached anyway, and one that has
 * stopped is dropped by its own modified time before it is ever read.
 */
export function helpersWorking(record: string, now: number): { out: number; since: number | null } {
  const dir = sentOffDir(record);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { out: 0, since: null }; // A chat that has sent nothing off.
  }
  let out = 0;
  let since: number | null = null;
  for (const name of names) {
    if (!/^agent-(.+)\.jsonl$/.test(name)) continue;
    const file = join(dir, name);
    let moved: number;
    let born: number;
    try {
      const stats = statSync(file);
      moved = stats.mtimeMs;
      born = stats.birthtimeMs;
    } catch {
      continue; // Taken away between the listing and the stat.
    }
    if (now - moved > HELPER_QUIET_MS) continue;
    // Its own last line, read the way a chat's is — the same question, and the
    // same answer: a turn that owes something is a turn still being worked on.
    if (!answerOwed(lastSaidSync(file, { sentOff: true }))) continue;
    out += 1;
    // When it was sent off, which is when its file was made. Not every disk
    // will say; the count stands either way and only the clock is lost.
    if (Number.isFinite(born) && born > 0 && (since === null || born < since)) since = born;
  }
  return { out, since };
}

/**
 * One agent's row and conversation, read from its own file.
 *
 * Null when there is no such file, or none that can be read: one helper being
 * unreadable loses that helper and not the chat around it.
 */
export function helperNamed(record: string, agentId: string): HelperPast | null {
  const dir = sentOffDir(record);
  let lines: HelperLine[];
  try {
    lines = readFileSync(join(dir, `agent-${agentId}.jsonl`), 'utf8')
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
    return null;
  }
  let meta: HelperMeta = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, `agent-${agentId}.meta.json`), 'utf8')) as HelperMeta;
  } catch {
    // No meta means no call to hang it off; the row still says what it spent.
  }
  return helperFrom(agentId, meta, lines);
}

/**
 * Every helper a chat sent off, oldest first.
 *
 * `record` is the chat's own file. A chat that sent nothing off has no such
 * directory, which is not a fault and comes back empty. One helper's file being
 * unreadable loses that helper and not the rest: the chat is drawn either way.
 */
export function helpersOf(record: string): HelperPast[] {
  const found: HelperPast[] = [];
  for (const agentId of helpersNow(record).keys()) {
    const helper = helperNamed(record, agentId);
    if (helper) found.push(helper);
  }
  return found.sort((a, b) => a.at.localeCompare(b.at));
}
