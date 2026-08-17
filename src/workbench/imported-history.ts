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

/** One recorded message, as much of it as reading a past chat needs. */
interface RecordedMessage {
  type?: string;
  message?: unknown;
}

/** One row of a chat that already happened, in the order it happened. */
export type PastEntry =
  | { kind: 'said'; role: 'user' | 'assistant'; text: string }
  | { kind: 'call'; id: string; name: string; input: Record<string, unknown>; output: string; ok: boolean };

/** What each call in the record printed, by the id the call was made under. */
function resultsByCall(messages: RecordedMessage[]): Map<string, { output: string; ok: boolean }> {
  const results = new Map<string, { output: string; ok: boolean }>();
  for (const m of messages) {
    const content = (m.message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const output = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      results.set(b.tool_use_id, { output, ok: !b.is_error });
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
