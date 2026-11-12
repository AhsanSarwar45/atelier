import { prefillChat } from '@/workbench/tasks/composer-prefill';

/** What the New task button writes into a chat's composer. */
export const NEW_TASK_LINE = '@task ';

/** The chat whose composer takes focus the next time it is drawn. */
let focusFor: string | null = null;

/** The line the next chat started from New task gets, when it is not the plain `@task `. */
let newChatLine: string | null = null;

/**
 * Puts `@task ` — or the line given, such as a grid selection's
 * `@task @grid:camera.*.gpu ` — into a chat's unsent line and asks for its
 * composer to be focused when the chat is next drawn. The line is in the
 * chat's own store (drafts.ts), so it is there whether the chat screen is up
 * yet or not.
 */
export function startTaskIn(sessionId: string, line: string = NEW_TASK_LINE): void {
  prefillChat(sessionId, line);
  focusFor = sessionId;
}

/**
 * The line the chat New chat starts next should get, set just before the New
 * chat dialog is asked for (`newchat=task`). Null puts back the plain `@task `.
 */
export function lineForNewChat(line: string | null): void {
  newChatLine = line;
}

/** The line the chat just started gets; read once. */
export function takeNewChatLine(): string {
  const line = newChatLine ?? NEW_TASK_LINE;
  newChatLine = null;
  return line;
}

/** Whether this chat's composer was asked to take focus; answers yes once. */
export function takeComposerFocus(sessionId: string | null): boolean {
  if (!sessionId || focusFor !== sessionId) return false;
  focusFor = null;
  return true;
}
