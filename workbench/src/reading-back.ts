/**
 * A row of a chat's own record, said in the events that would have carried it
 * live — so a turn read off the disk and one watched as it happened open the
 * same way (docs/agent-workbench.md §8.2.4).
 *
 * Its own module, apart from the sessions that publish what it makes, so what a
 * record turns into can be read off without a store, a driver or the agent kit
 * behind it. That is the thing worth holding still.
 */
import type { PastEntry } from '../../src/workbench/imported-history.ts';
import type { DriverEvent } from './drivers/types.ts';

/**
 * One spoken row: the message opening, the pictures it held, its words, the
 * message closing.
 *
 * A picture goes out BEFORE the words, which is exactly where a picture just
 * pasted into the writing box is announced — so a picture read off the disk and
 * one sent a moment ago reach the transcript as the same event and draw by the
 * same rule, with no second path to keep working. Reading the words alone is
 * what left the manager looking at the bare marker `[Image #1]` in his own
 * message with nothing to click (bw-uu9x.2).
 */
export function spokenAsEvents(
  entry: Extract<PastEntry, { kind: 'said' }>,
  messageId: string,
): DriverEvent[] {
  const events: DriverEvent[] = [{ type: 'message.started', messageId, role: entry.role }];
  for (const image of entry.images) events.push({ type: 'image', messageId, image });
  // A message that is a picture and nothing else says nothing, and an empty
  // word is still a word in the log.
  if (entry.text) events.push({ type: 'text.delta', messageId, text: entry.text });
  events.push({ type: 'message.completed', messageId });
  return events;
}
