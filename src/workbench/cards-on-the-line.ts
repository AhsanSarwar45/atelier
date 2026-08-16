/**
 * How many cards a row of chrome can name before it stops being a row.
 *
 * Measured (docs/agent-workbench.md §8.2.1): one chat's 26 card chips drew a row
 * 2277 px wide inside a pane about 700 px wide, and squeezed the words naming
 * the agent to 37 px. Both the open chat's own line and a row in the list of
 * chats read from here, so they crowd the same way or not at all.
 */

/** The open chat's line, which also carries the agent's name and the folder. */
export const CARDS_ON_THE_LINE = 3;

/** A row in the 288px rail, which has far less room. */
export const CARDS_ON_A_ROW = 2;

/**
 * Which cards go on the line and which become a count. The leftovers are a
 * count, not a scroll: a chat that has worked on twenty cards is saying how
 * much it has done, and the names ride in the count's tooltip.
 */
export function cardsOnTheLine(cards: string[], room = CARDS_ON_THE_LINE): { shown: string[]; rest: string[] } {
  if (cards.length <= room) return { shown: cards, rest: [] };
  return { shown: cards.slice(0, room), rest: cards.slice(room) };
}
