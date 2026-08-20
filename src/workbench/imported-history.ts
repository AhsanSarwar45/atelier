/**
 * Reading a chat's own record back into the transcript.
 *
 * The agent kit keeps every chat's messages; this turns one of those into the
 * words a reader wants to see again, and drops the lines the harness itself put
 * there — the notifications it posts to an agent about background work, the
 * reminders it wraps around a turn, the echo of a typed command. Nobody said
 * those, and in the middle of a conversation they read as noise
 * (docs/agent-workbench.md §6.3.2).
 */

/**
 * A picture read out of a record is an `ImagePayload` and nothing else: the very
 * shape a picture just pasted into the writing box has, so both reach the
 * transcript as the same thing and are drawn by the same rule, with no second
 * shape to keep in step (bw-uu9x.1, bw-uu9x.8).
 */
import type { ImagePayload } from './protocol';

/** How much of a chat's past is drawn when it is opened. */
export const IMPORTED_MESSAGES = 200;

/**
 * Which reading of a past chat's record this build does.
 *
 * 1 was the words alone. 2 is the words and the commands, which is what the
 * manager asked for after photographing the difference (§6.3.2). 3 adds the
 * change each edit made, so a chat begun in a terminal draws its edits as
 * red-and-green rather than as the new text alone (bw-4wcd.1). 4 adds how full
 * the conversation stands, which a chat begun in a terminal has no driver here
 * to say (bw-4wcd.4). 5 takes the window off what the kit states in the record
 * rather than off a marker in the model's name that the kit never writes
 * (bw-4wcd.15). 6 carries the pictures a message held, which every reading
 * before it dropped on the floor — leaving the bare marker the harness writes
 * in their place and nothing to click (bw-uu9x.1). Raise it whenever the
 * reading would produce a different transcript from the same record: every chat
 * read in by a lower one is read again on its next open.
 *
 * It lives beside the reading it numbers, so raising the reading and raising
 * the number are one edit in one file (bw-khe.11).
 */
export const IMPORT_RECIPE = 6;

/** What opening a chat does about a past it may or may not have read already. */
export type ReadingChoice =
  /** Read the record and draw it, replacing whatever older copy is there. */
  | 'read-it'
  /** Already read by this reading; a re-read would change nothing. */
  | 'leave-it'
  /**
   * Read once by an older reading AND spoken to here since. Those live turns
   * exist nowhere but the log, so reading the record again would throw away the
   * only copy; the chat keeps its older drawing and is written off as current.
   */
  | 'keep-what-it-has';

/**
 * What is already known about a chat before its record is opened.
 *
 * The two facts that cost a question to the log are asked as questions, not
 * handed over as answers, because the common case — a chat already read by this
 * very reading — is decided without either of them, and asking anyway put a
 * count over the whole log on every single open (bw-m8o.14).
 */
export interface ReadSoFarState {
  /** The reading that last read this chat in, or null if none ever did. */
  readBy: number | null;
  /** Whether this is the follower catching up rather than a reader opening it. */
  live: boolean;
  /** How many rows its log already holds. */
  drawn: () => number;
  /** Whether any of those rows came from a turn driven here rather than read in. */
  drivenHere: () => boolean;
}

/**
 * What to do with a chat's past when it is opened.
 *
 * A chat read in under an older reading has to be read again, or the reader
 * goes on seeing the transcript the old rules made — harness lines and all —
 * with no way to ask for the new one short of deleting the chat. But a chat
 * that was ALSO driven here holds turns that exist in no record, and reading
 * its record again would drop them, so that one keeps what it has and is
 * simply written off as current (bw-1u1.26, bw-khe.11).
 */
export function howToRead(was: ReadSoFarState): ReadingChoice {
  if (!was.live && was.readBy !== null && was.readBy >= IMPORT_RECIPE) return 'leave-it';
  const drawnAlready = was.readBy !== null || was.drawn() > 0;
  if (drawnAlready && was.drivenHere()) return 'keep-what-it-has';
  return 'read-it';
}

/** Where a chat's record had been read up to when the reader last looked away. */
export interface ReadUpTo {
  /** A line boundary in the record. */
  at: number;
  /** How many rows of the transcript built from that byte are already drawn. */
  drawn: number;
}

/** What is known about how far a live chat's record has already been read. */
export interface ReadUpToState {
  /** The reading that last read this chat in, or null if none ever did. */
  readBy: number | null;
  /** Where its follower left off last time, or null if none ever did. */
  followedTo: ReadUpTo | null;
  /** How long the record stands right now, or null if it is not on this machine. */
  recordNow: number | null;
}

/**
 * Where opening a live chat picks up in its own record, or null to read the lot.
 *
 * A chat another program is driving is never finished being read, so it fell
 * through every "already read" test and was read from its first byte on every
 * single click — the whole record parsed, the drawing thrown away, the
 * conversation published again. That is the several seconds the manager waits
 * on exactly the chats he watches most (bw-uiyz.19).
 *
 * Three things have to hold to skip it: this build's own reading is what drew
 * what is on the screen, its follower left a mark before the reader looked
 * away, and the record is still at least that long — one that came back SHORTER
 * has been compacted under us, and the byte means nothing in the new one.
 */
export function carryOnAt(was: ReadUpToState): ReadUpTo | null {
  if (was.readBy === null || was.readBy < IMPORT_RECIPE) return null;
  if (was.followedTo === null) return null;
  if (was.recordNow === null || was.recordNow < was.followedTo.at) return null;
  return was.followedTo;
}

/** Openings that mark a line the harness wrote rather than a person or an agent. */
const MACHINE_CHATTER =
  /^<(task-notification|system-reminder|local-command-[a-z-]+|command-name|command-message|command-args|user-prompt-submit-hook|function_results|budget)\b/;

/** The words in one recorded message; blocks that are not words are skipped. */
export function textOf(message: unknown): string {
  const body = message as { content?: unknown } | null;
  const content = body?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * How much encoded picture a message may carry back out of the record.
 *
 * A picture is carried whole, because that is what makes it clickable, and the
 * whole of it then lives in the chat's stored history as well. One screenshot
 * is a couple of hundred kilobytes and costs nothing; a chat somebody pasted a
 * hundred of into would be read into memory and written to disk entire. Past
 * this, the picture is named and measured in the words instead — the reader
 * still learns it was there, and the record on disk still holds it (bw-uu9x.3).
 */
export const PICTURE_KEPT = 1_000_000;

/** How big a base64 payload is, in the terms a reader judges big or small by. */
function measured(data: unknown): string {
  // base64 spends four characters per three bytes, which is close enough for a
  // size a reader is only deciding "big or small" from.
  const bytes = typeof data === 'string' ? Math.round((data.length * 3) / 4) : 0;
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

/**
 * The marker the harness writes where a picture was pasted, with whatever
 * spacing sits either side of it — the space belongs to the marker, and goes
 * with it.
 */
const PICTURE_MARKER = /[^\S\n]*\[Image #\d+\][^\S\n]*/g;

/**
 * The words with the harness's picture markers lifted out of them.
 *
 * The number in `[Image #2]` counts the pictures of the whole conversation, not
 * the blocks of the one message: a real record of this project's own holds a
 * message whose two pictures are a png then a jpeg while its words read
 * `…[Image #2]…[Image #1]` — the png being the one called #2. So no marker is
 * matched to a picture, because that match would be wrong; every marker goes,
 * since every picture it could name is already drawn above the words, and the
 * ones that could not be drawn are named after them instead (bw-uu9x.6).
 *
 * Only the lines a marker stood on are touched: the space either side of a
 * lifted marker closes up, a line that was a marker and nothing else goes with
 * it, and every other line keeps the spacing it was written with — an aligned
 * table or a pasted snippet in the same message is not squashed for having a
 * screenshot beside it (bw-uu9x.7).
 */
function withoutMarkers(said: string): string {
  if (!said.includes('[Image #')) return said;
  const kept: string[] = [];
  for (const line of said.split('\n')) {
    if (!line.includes('[Image #')) {
      kept.push(line);
      continue;
    }
    const stripped = line.replace(PICTURE_MARKER, (marker, at: number) =>
      at === 0 || at + marker.length === line.length ? '' : ' ',
    );
    if (stripped.trim() !== '') kept.push(stripped);
  }
  return kept.join('\n').trim();
}

/**
 * What one message holds: its words, and the pictures pasted into it.
 *
 * The harness does not put a picture in the words — it puts `[Image #1]` there
 * and the bytes in a block of their own. Reading the words alone left that
 * marker standing over nothing, which is exactly what the manager was looking
 * at (bw-uu9x). So the two are read together: each picture is carried and drawn
 * where the message begins, and the markers come out of the words because the
 * pictures themselves now stand there. A picture too big to carry is named and
 * measured under the words instead, so the reader is never quietly short of one.
 */
export function saidWithPictures(message: unknown): { text: string; images: ImagePayload[] } {
  const said = textOf(message);
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return { text: said, images: [] };

  const images: ImagePayload[] = [];
  /** A line for each picture that could not be carried, in the order held. */
  const undrawn: string[] = [];
  let nth = 0;

  for (const block of content) {
    const b = (typeof block === 'object' && block !== null ? block : {}) as {
      type?: string;
      source?: { type?: string; media_type?: string; data?: unknown };
    };
    if (b.type !== 'image') continue;
    nth += 1;
    const mime = b.source?.media_type ?? 'image/png';
    const data = b.source?.data;
    // Only base64 is carried: a block naming a file or an address holds no
    // bytes here to turn into something the browser can draw.
    const whole =
      b.source?.type === 'base64' && typeof data === 'string' && data.length <= PICTURE_KEPT;
    if (whole) {
      images.push({ mime, dataUrl: `data:${mime};base64,${data as string}`, alt: `Picture ${nth}` });
    } else {
      undrawn.push(`[${mime}, ${measured(data)}]`);
    }
  }

  if (nth === 0) return { text: said, images: [] };

  return { text: [withoutMarkers(said), ...undrawn].filter(Boolean).join('\n'), images };
}

/** Whether a recorded message is something a person or an agent actually said. */
export function saidByAnyone(text: string): boolean {
  return text.length > 0 && !MACHINE_CHATTER.test(text.trimStart());
}

/** One tool call as the record kept it: enough for the link rules to judge it. */
export interface PastToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * The tool calls inside one recorded message.
 *
 * Read twice over, for two different purposes: the same rules the live watcher
 * uses (src/workbench/link-rules.ts) decide from them which cards the chat
 * worked on and which reports it wrote, and `pastTranscript` turns them into
 * the rows a reader sees.
 */
export function toolCallsOf(message: unknown): PastToolCall[] {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (block): block is { type: 'tool_use'; name: string; input?: unknown } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: string }).type === 'tool_use' &&
        typeof (block as { name?: unknown }).name === 'string',
    )
    .map((block) => ({
      name: block.name,
      input: (typeof block.input === 'object' && block.input !== null
        ? block.input
        : {}) as Record<string, unknown>,
    }));
}

/**
 * Every tool call in a whole record, handed to whatever makes the links.
 *
 * The live watcher is given each call as it happens; a chat this app never
 * watched has none of those, only the record. This is how the two are made the
 * same call for the same rules, and it is one function rather than a loop
 * written twice so that a chat read in cannot quietly stop bringing its cards
 * and its reports while the live path keeps working (bw-khe.10).
 */
export function linkPast(
  messages: { message?: unknown }[],
  observe: (name: string, input: Record<string, unknown>) => void,
): void {
  for (const m of messages) {
    for (const call of toolCallsOf(m.message)) observe(call.name, call.input);
  }
}

/** One recorded message, as much of it as reading a past chat needs. */
interface RecordedMessage {
  type?: string;
  message?: unknown;
}

/** One row of a chat that already happened, in the order it happened. */
export type PastEntry =
  | { kind: 'said'; role: 'user' | 'assistant'; text: string; images: ImagePayload[] }
  | { kind: 'call'; id: string; name: string; input: Record<string, unknown>; output: string; ok: boolean };

/**
 * How much of any one body is kept: a command's arguments, what it printed, a
 * quiet line's whole message. One number, because a reader meeting two of them
 * on the same row should not find one cut and the other running to fifty
 * kilobytes (bw-1u1.33).
 *
 * The body is there to be READ, and the whole of it is already on disk in the
 * kit's own record.
 */
export const KEPT = 4000;

/** Cut to `KEPT`, saying how much was left out rather than trailing off. */
export function cut(text: string, kept = KEPT): string {
  return text.length > kept ? `${text.slice(0, kept)}\n… and ${text.length - kept} more characters` : text;
}

/**
 * What a command was asked to do, small enough to read and to store.
 *
 * A `Write` or an `Edit` carries the whole file in one of its arguments. That
 * was cut nowhere — so the first sizeable file the agent touched opened the row
 * onto every byte of it, and an imported chat wrote every byte into the stored
 * history as well (bw-1u1.33). Each value is cut where the output is, however
 * deep it sits: a multi-edit hides whole files one list and one object down.
 * `depth` is a guard against a value that refers to itself, nothing more.
 */
export function trimInput(input: Record<string, unknown>, depth = 4): Record<string, unknown> {
  const small = (value: unknown, left: number): unknown => {
    if (typeof value === 'string') return cut(value);
    if (left <= 0 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => small(v, left - 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, small(v, left - 1)]));
  };
  return small(input, depth) as Record<string, unknown>;
}

/**
 * What a command printed, in a form a reader can read.
 *
 * A result comes back as a string or as the kit's blocks, and a block that is
 * not text — a screenshot, a picture the agent read — carries its bytes encoded
 * as base64. Turning the lot into raw JSON put thousands of characters of that
 * encoding where the picture belongs, which nobody saw while the browser was
 * throwing command output away and everybody saw the moment it stopped
 * (bw-1u1.30). Such a block is named and measured instead.
 */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((block) => {
      const b = (typeof block === 'object' && block !== null ? block : {}) as {
        type?: string;
        text?: unknown;
        source?: { media_type?: string; data?: unknown };
      };
      if (b.type === 'text') return String(b.text ?? '');
      if (b.type === 'image') {
        return `[${b.source?.media_type ?? 'image'}, ${measured(b.source?.data)}]`;
      }
      return `[${b.type ?? 'unknown'}]`;
    })
    .join('\n');
}

/** What each call in the record printed, by the id the call was made under. */
function resultsByCall(messages: RecordedMessage[]): Map<string, { output: string; ok: boolean }> {
  const results = new Map<string, { output: string; ok: boolean }>();
  for (const m of messages) {
    const content = (m.message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      results.set(b.tool_use_id, { output: resultText(b.content), ok: !b.is_error });
    }
  }
  return results;
}

/**
 * A chat's own record read back as the rows a reader sees: what was said, and
 * every command that was run, in one order.
 *
 * The commands are here because an earlier build imported the words alone, and
 * the manager photographed the result — the same session showing every command
 * and its output in his terminal, and sentences only here
 * (docs/agent-workbench.md §6.3.2).
 */
export function pastTranscript(messages: RecordedMessage[]): PastEntry[] {
  const results = resultsByCall(messages);
  const entries: PastEntry[] = [];

  for (const m of messages) {
    if (m.type !== 'user' && m.type !== 'assistant') continue;
    const { text, images } = saidWithPictures(m.message);
    // A message that is a picture and nothing else has no words to judge, and
    // it is still something he said — so a picture is reason enough to draw the
    // row (bw-uu9x.1).
    if (saidByAnyone(text) || images.length > 0) entries.push({ kind: 'said', role: m.type, text, images });

    // A message's own words come before the calls it made, which is the order
    // they happened in and the order the live wire sends them.
    const content = (m.message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; id?: string; name?: string; input?: unknown };
      if (b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
      const result = results.get(b.id);
      entries.push({
        kind: 'call',
        id: b.id,
        name: b.name,
        input: (typeof b.input === 'object' && b.input !== null ? b.input : {}) as Record<string, unknown>,
        output: result?.output ?? '',
        // No result in the record means the chat ended before the call came
        // back; that is not a failure, so it is not drawn as one.
        ok: result?.ok ?? true,
      });
    }
  }
  return entries;
}

/**
 * How much of a record may be drawn while it is still being written.
 *
 * A command is written into the record when it is made, and what it printed
 * lands in a later entry. So the last entries of a chat somebody is working in
 * right now are often calls with nothing back yet, and drawing one of those
 * draws it finished and empty — a row nothing revisits, because the log is the
 * transcript and what is written there stays written (§4).
 *
 * The tail is therefore held back until something follows it. A command that
 * genuinely printed nothing waits for the chat's next word, which is a delay
 * nobody sees rather than a wrong row that stays wrong (bw-dmxj.6).
 *
 * Only for FOLLOWING a live record. Reading a finished chat draws all of it:
 * there, a call with nothing back means the chat ended before the answer came.
 */
export function settledUpTo(entries: PastEntry[]): number {
  let n = entries.length;
  for (let i = entries.length - 1; i !== -1; i -= 1) {
    const last = entries[i]!;
    if (last.kind !== 'call') break;
    if (last.output !== '') break;
    n = i;
  }
  return n;
}

/**
 * A message the reader should not be shown, judged from the event that opened
 * it. Applied where the log is read rather than where it is written, so a chat
 * read in by an older build stops showing harness lines without being read
 * again — reading it again would say everything twice (§4).
 */
export function chatterMessageIds(events: { type: string; messageId?: string; role?: string; text?: string }[]): Set<string> {
  const opened = new Map<string, string>();
  const chatter = new Set<string>();
  for (const e of events) {
    if (e.type === 'message.started' && e.messageId) opened.set(e.messageId, '');
    if (e.type === 'text.delta' && e.messageId && opened.has(e.messageId)) {
      const so_far = opened.get(e.messageId)!;
      // Only the opening of a message decides: a quoted notification further
      // down is part of what someone said about it.
      if (so_far.length === 0 && !saidByAnyone(e.text ?? '')) chatter.add(e.messageId);
      opened.set(e.messageId, so_far + (e.text ?? ''));
    }
  }
  return chatter;
}

/** The log with the harness's own messages taken out of it. */
export function withoutMachineChatter<T extends { type: string; messageId?: string; text?: string }>(events: T[]): T[] {
  const chatter = chatterMessageIds(events);
  if (chatter.size === 0) return events;
  return events.filter((e) => !(e.messageId && chatter.has(e.messageId)));
}

/** The change one tool call made to one file: what it took out, what it put in. */
export interface ToolDiff {
  path: string;
  before: string;
  after: string;
}

/**
 * The change a tool call carries, or null when it changed no file.
 *
 * One rule for both halves of the app: the live watcher reads it off the call as
 * it happens, and a chat read back out of the kit's own record reads it off the
 * same arguments. Without the second, a conversation begun in a terminal drew
 * every edit as bare text and never as a change — which is the whole of what the
 * manager was looking at (bw-4wcd.1).
 *
 * Everything is cut where a command's arguments and its output are cut: a Write
 * carries a whole file in one argument.
 */
export function diffOf(name: string, input: Record<string, unknown>): ToolDiff | null {
  const path = String(input.file_path ?? '');
  if (!path) return null;
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return { path, before: cut(input.old_string), after: cut(input.new_string) };
  }
  if (name === 'Write' && typeof input.content === 'string') {
    return { path, before: '', after: cut(input.content) };
  }
  // Several edits to one file arrive as a list, and each is a change of its own.
  // Run together they read as one, which is how they were made.
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const edits = input.edits.filter(
      (e): e is { old_string: string; new_string: string } =>
        typeof e === 'object' && e !== null &&
        typeof (e as { old_string?: unknown }).old_string === 'string' &&
        typeof (e as { new_string?: unknown }).new_string === 'string',
    );
    if (!edits.length) return null;
    return {
      path,
      before: cut(edits.map((e) => e.old_string).join('\n')),
      after: cut(edits.map((e) => e.new_string).join('\n')),
    };
  }
  return null;
}
