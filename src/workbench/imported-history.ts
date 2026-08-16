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
 * A past chat's tools cannot be re-run, so none of these becomes a row in the
 * transcript. They are read for one purpose: the same rules the live watcher
 * uses (src/workbench/link-rules.ts) decide from them which cards the chat
 * worked on and which reports it wrote.
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
