import { addressWith } from '@/lib/address';

/**
 * Opens a task's detail in the Tasks tab from a card or row in a chat. A new
 * history entry, so Back returns to the chat (the checklist does the same).
 */
export function openTaskDetail(number: number): void {
  window.history.pushState(null, '', addressWith(new URLSearchParams(window.location.search), { tab: 'tasks', task: number, message: null }));
}
