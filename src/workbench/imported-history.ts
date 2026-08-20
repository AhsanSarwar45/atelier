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

/** How much of a chat's past is drawn when it is opened. */
export const IMPORTED_MESSAGES = 200;

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
  | { kind: 'said'; role: 'user' | 'assistant'; text: string }
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
        const kind = b.source?.media_type ?? 'image';
        // base64 spends four characters per three bytes, which is close enough
        // for a size a reader is only deciding "big or small" from.
        const bytes = typeof b.source?.data === 'string' ? Math.round((b.source.data.length * 3) / 4) : 0;
        return `[${kind}, ${bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`}]`;
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
    const said = textOf(m.message);
    if (saidByAnyone(said)) entries.push({ kind: 'said', role: m.type, text: said });

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
