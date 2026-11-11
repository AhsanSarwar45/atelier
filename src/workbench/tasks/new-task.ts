import { prefillChat } from '@/workbench/tasks/composer-prefill';

/** What the New task button writes into a chat's composer. */
export const NEW_TASK_LINE = '@task ';

/** The chat whose composer takes focus the next time it is drawn. */
let focusFor: string | null = null;

/**
 * Puts `@task ` into a chat's unsent line and asks for its composer to be
 * focused when the chat is next drawn. The line is in the chat's own store
 * (drafts.ts), so it is there whether the chat screen is up yet or not.
 */
export function startTaskIn(sessionId: string): void {
  prefillChat(sessionId, NEW_TASK_LINE);
  focusFor = sessionId;
}

/** Whether this chat's composer was asked to take focus; answers yes once. */
export function takeComposerFocus(sessionId: string | null): boolean {
  if (!sessionId || focusFor !== sessionId) return false;
  focusFor = null;
  return true;
}
