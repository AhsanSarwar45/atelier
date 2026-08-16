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
