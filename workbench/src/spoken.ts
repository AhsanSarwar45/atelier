/**
 * When the person themselves last spoke in a chat.
 *
 * The chat list is ordered by when something last happened, and everything an
 * agent does counts as something: a reply, a line of thinking, a question about
 * a tool, a card it linked. So a row climbs to the top all night while nobody
 * is there, and the chats the manager is actually holding a conversation with
 * slide about under his cursor as three agents write. The order he wants is the
 * last time HE said something, which is a second clock, beside the first and
 * never instead of it (bw-zhs9).
 *
 * For a chat this app drove, that clock is a column of our own: the sidecar
 * sees the send and stamps it. For a chat begun in a terminal or in an editor
 * nothing of ours ever saw it, and the kit's own session index cannot say
 * either — an entry there carries the record file's modification time and not a
 * word about who wrote last. The answer is written down in exactly one place,
 * the record itself, so that is what this reads.
 *
 * Two rules keep that from becoming a scan of every conversation on the
 * machine, which is the thing this app has spent bw-uiyz undoing:
 *
 * - The record is read from the END, backwards, a chunk at a time, and the walk
 *   stops at the first thing the person said or after `TAIL_LIMIT` — never the
 *   whole file. Measured over the 823 records on this machine that hold
 *   anything a person said, the last thing he wrote sits 42KB from the end for
 *   half of them and within a megabyte for 760 of them; the rest keep the clock
 *   they have today, which is exactly what the list does now.
 * - The answer is remembered against the file's length and its modification
 *   time, so an unchanged record is never read twice. The kit only ever appends,
 *   so a record that HAS grown is read over the new bytes alone, forwards, from
 *   the byte the last look stopped at — the same reasoning as record-tail.ts.
 *
 * Nothing here writes. The records belong to Claude Code.
 */
import { open, stat } from 'node:fs/promises';

import { laterOf } from '../../src/workbench/protocol.ts';
import { findRecord } from './record-tail.ts';
import { claudeConfigDir } from './running.ts';

/**
 * How far back from the end of a record the walk may go before giving up.
 *
 * A megabyte is where the measurement above stops paying: it covers 92% of the
 * records on this machine, and the ones it misses are the enormous ones, where
 * doubling the budget buys another handful of percent and four times the
 * reading on every record that needs none of it.
 */
export const TAIL_LIMIT = 1_048_576;

/** How much of the end is read at a time on the way back. */
export const CHUNK = 131_072;

/**
 * One line of a record, in the fields that say whether the person wrote it.
 *
 * Deliberately not the whole line: this reads a format the kit owns, and naming
 * only what the question needs is what keeps a new field of theirs from
 * becoming a problem of ours.
 */
export interface RecordedLine {
  type?: string;
  timestamp?: string;
  /** How the prompt got here: typed, queued behind a turn, or sent by a program. */
  promptSource?: string;
  /** Who produced it — the kit says `human` when a person did. */
  origin?: { kind?: string };
  toolUseResult?: unknown;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
}

/**
 * The time on a line the person actually wrote, and nothing on any other line.
 *
 * This filter is the whole of the card. A record is full of lines that say
 * `"type":"user"` and are not the person speaking, and counting one of them as
 * speech puts the list straight back where it started — an agent running a
 * hundred commands would move the clock a hundred times. Counted against the
 * 86,688 `user` lines in the 863 records on this machine, the impostors are:
 *
 * - **Tool results** — 79,292 of them, four in every five lines in the file.
 *   They carry `toolUseResult` and a `content` of `tool_result` blocks, and
 *   they are the answer a machine gave the agent, not anything anybody said.
 * - **Notices the harness writes into the conversation** — a subagent finishing
 *   (1,395), a message from another Claude (35), a turn carried on
 *   automatically (1). These have no tool result and are not marked meta, so
 *   nothing but their own words gives them away: the kit stamps them
 *   `promptSource: "system"` and names the origin — `task-notification`,
 *   `peer`, `auto-continuation` — where a person's line says `human`.
 * - **The kit's own bookkeeping** — `isMeta` lines (982): the caveat before a
 *   local command's output, hook feedback, the note naming a pasted image's
 *   file, a skill's instructions. And `isCompactSummary` (306): the summary a
 *   compaction leaves behind, which is Claude writing about the conversation.
 * - **Command wrappers and their output** (1,487) — `<command-name>/model…`,
 *   `<local-command-stdout>…`, `<bash-input>`, and `[Request interrupted by
 *   user]`. Pressing a key is not saying something, and none of these carries a
 *   `promptSource` at all, which is what leaves them out here.
 *
 * What is left, 3,188 lines, is the person: a `promptSource` of `typed`,
 * `queued` (typed while the agent was still going) or `suggestion_accepted`,
 * and, for a chat this app or another program drives, `sdk` — the manager's own
 * words, relayed through the kit by whatever he typed them into.
 *
 * `origin` is read as an allow-list rather than as a list of machine origins to
 * refuse, because the two mistakes are not the same size. A machine origin we
 * have not heard of, let through, moves the clock for an agent and undoes the
 * card. A human origin we have not heard of, refused, falls back to something
 * the person said earlier, or to the clock the row carries today.
 */
export function spokenAt(line: RecordedLine): string | null {
  if (line.type !== 'user') return null;
  if (line.isSidechain === true || line.isMeta === true || line.isCompactSummary === true) return null;
  if (line.toolUseResult !== undefined) return null;
  if (typeof line.promptSource !== 'string' || line.promptSource === 'system') return null;
  const who = line.origin?.kind;
  if (who !== undefined && who !== 'human') return null;
  return typeof line.timestamp === 'string' ? line.timestamp : null;
}

/**
 * Whether a stretch of a record is worth taking apart at all.
 *
 * Every line the person wrote names `promptSource`; four lines in five are tool
 * results, which are the long ones and never do. So a stretch without those
 * twelve letters anywhere in it holds nothing to find, and is skipped without
 * being decoded from bytes or handed to a JSON reader. Matched on the name
 * alone, not on how the kit spaces its JSON, and a stretch that matches for a
 * silly reason — a command whose output quoted a record, say — costs one parse
 * that then says no.
 */
function worthReading(bytes: Buffer): boolean {
  return bytes.includes('promptSource');
}

/** The time on a line of text, if the person wrote it. */
function spokenIn(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return spokenAt(JSON.parse(trimmed) as RecordedLine);
  } catch {
    // Half a line, or something the kit writes that is not JSON.
    return null;
  }
}

/** What one look at a record found, and where the next look starts from. */
interface Looked {
  at: string | null;
  /**
   * One past the last line break this look reached. Never the file's length: a
   * record caught mid-line ends in a line that is still being written, and
   * starting the next look after it would drop it unread.
   */
  upto: number;
}

/** What is remembered about a record, so an unchanged one is never read again. */
interface Answer extends Looked {
  size: number;
  mtimeMs: number;
}

const answers = new Map<string, Answer>();
/** Where each chat's record lives. A record never moves, so this is asked once. */
const paths = new Map<string, string>();

/** Only for tests: forget every record's place and every answer read off one. */
export function forgetSpoken(): void {
  answers.clear();
  paths.clear();
}

/**
 * The last thing the person said, walking back from the end of the record.
 *
 * Whole lines only: the piece at the front of a chunk begins mid-line, so it is
 * carried — as bytes, never as text, or a character split across the boundary
 * would come back mangled and take its line with it — and joined to the chunk
 * before it.
 */
async function walkBack(path: string, size: number): Promise<Looked> {
  const handle = await open(path, 'r');
  try {
    let end = size;
    let carry = Buffer.alloc(0);
    let read = 0;
    let upto = 0;
    while (end > 0 && read < TAIL_LIMIT) {
      const start = Math.max(0, end - CHUNK);
      const buffer = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      read += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      const window = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      // Where a later look should carry on from: after the last whole line the
      // record holds, which only the chunk at the very end can say.
      if (end === size) {
        const ended = window.lastIndexOf(0x0a);
        upto = ended === -1 ? start : start + ended + 1;
      }
      end = start;

      // The head of the window is a whole line only once the walk has reached
      // the start of the file; until then it waits for the chunk before it.
      let from = 0;
      if (start > 0) {
        const broke = window.indexOf(0x0a);
        if (broke === -1) {
          carry = Buffer.from(window);
          continue;
        }
        carry = Buffer.from(window.subarray(0, broke));
        from = broke + 1;
      } else {
        carry = Buffer.alloc(0);
      }

      const rest = window.subarray(from);
      if (!worthReading(rest)) continue;
      const lines = rest.toString('utf8').split('\n');
      // Backwards, because the last thing he said is the one being asked for.
      for (let i = lines.length - 1; i >= 0; i--) {
        const said = spokenIn(lines[i]!);
        if (said) return { at: said, upto };
      }
    }
    return { at: null, upto };
  } finally {
    await handle.close();
  }
}

/** The last thing the person said in the bytes a record has gained since. */
async function walkOn(path: string, from: number, to: number): Promise<Looked> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(to - from);
    const { bytesRead } = await handle.read(buffer, 0, to - from, from);
    const grown = buffer.subarray(0, bytesRead);
    const ended = grown.lastIndexOf(0x0a);
    const upto = ended === -1 ? from : from + ended + 1;
    if (ended === -1 || !worthReading(grown)) return { at: null, upto };
    let said: string | null = null;
    for (const line of grown.subarray(0, ended).toString('utf8').split('\n')) {
      said = spokenIn(line) ?? said;
    }
    return { at: said, upto };
  } finally {
    await handle.close();
  }
}

/**
 * When the person last spoke in the chat the kit knows by this id, or nothing
 * if its record cannot be found or holds nothing he wrote within reach of the
 * end. The caller falls back to the clock the row already has.
 */
export async function lastSpokeAt(sessionId: string, config: string = claudeConfigDir()): Promise<string | null> {
  let path = paths.get(sessionId);
  if (path === undefined) {
    const found = findRecord(sessionId, config);
    if (found === null) return null;
    path = found;
    paths.set(sessionId, path);
  }

  let size: number;
  let mtimeMs: number;
  try {
    ({ size, mtimeMs } = await stat(path));
  } catch {
    // Gone since it was found. The place is asked for again next time, in case
    // the kit has since written the chat somewhere else.
    paths.delete(sessionId);
    answers.delete(path);
    return null;
  }

  const known = answers.get(path);
  if (known && known.size === size && known.mtimeMs === mtimeMs) return known.at;

  // Grown, which is what a record does. Only the new bytes are read, and they
  // either hold something he said — later than anything behind them — or leave
  // the answer where it stood. `laterOf` rather than "what was found wins",
  // because a look that starts before a half-written line reads a few lines
  // twice, and reading an older line twice must not move the clock backwards.
  if (known && size > known.size && known.upto <= size) {
    const seen = await walkOn(path, known.upto, size);
    const at = known.at ? laterOf(known.at, seen.at) : seen.at;
    answers.set(path, { at, upto: seen.upto, size, mtimeMs });
    return at;
  }

  // Never looked at, or rewritten under us — the kit compacted it — in which
  // case whatever stood here is about a file that no longer exists.
  const seen = await walkBack(path, size);
  answers.set(path, { ...seen, size, mtimeMs });
  return seen.at;
}
